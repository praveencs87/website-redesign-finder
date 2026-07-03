import { armKillSwitch, disarmKillSwitch } from './utils/timeoutManager.js';
import { Actor } from 'apify';
import { CheerioCrawler, log } from 'crawlee';

const CURRENT_YEAR = new Date().getFullYear();
const OLD_CMS_PATTERNS = [
    /wordpress\s+[\d.]+/i,
    /joomla[\s!]/i,
    /drupal\s+[5-7]/i,
    /wp-content\/themes/i,
];

// Audit a loaded Cheerio page for redesign signals
function auditPage($, url) {
    const signals = {};

    // 1. SSL check
    signals.no_ssl = url.startsWith('http://');

    // 2. Missing mobile viewport
    const viewport = $('meta[name="viewport"]').attr('content') || '';
    signals.no_mobile_viewport = !viewport;

    // 3. Missing meta description
    const metaDesc = $('meta[name="description"]').attr('content') || '';
    signals.no_meta_description = !metaDesc.trim();

    // 4. Missing favicon
    const favicon = $('link[rel*="icon"]').length;
    signals.no_favicon = favicon === 0;

    // 5. Old copyright year in footer
    const footerText = $('footer, #footer, .footer').text() + $('body').text().slice(-500);
    const yearMatches = footerText.match(/©\s*(\d{4})|copyright\s*(\d{4})/gi) || [];
    signals.old_copyright = false;
    for (const match of yearMatches) {
        const yearNum = parseInt(match.match(/\d{4}/)?.[0] || '0');
        if (yearNum > 0 && CURRENT_YEAR - yearNum >= 3) {
            signals.old_copyright = true;
            signals.copyright_year = yearNum;
            break;
        }
    }

    // 6. Old/outdated CMS detected
    const htmlContent = $.html();
    signals.old_cms_detected = OLD_CMS_PATTERNS.some(p => p.test(htmlContent));
    if (signals.old_cms_detected) {
        const matched = OLD_CMS_PATTERNS.find(p => p.test(htmlContent));
        signals.cms_hint = (htmlContent.match(matched) || [''])[0].substring(0, 30).trim();
    }

    // 7. No structured data (missed SEO opportunity)
    signals.no_schema_markup = $('script[type="application/ld+json"]').length === 0;

    // Calculate opportunity score (1 point per signal)
    const signalKeys = ['no_ssl', 'no_mobile_viewport', 'no_meta_description', 'no_favicon', 'old_copyright', 'old_cms_detected', 'no_schema_markup'];
    const opportunity_score = signalKeys.filter(k => signals[k] === true).length;

    return { signals, opportunity_score };
}

await Actor.init();

try {
    const input = await Actor.getInput();
    const {
        startUrls = [],
        niche = 'plumber',
        location = '',
        maxSites = 50,
        minOpportunityScore = 2,
        proxyConfiguration
    } = input || {};

    const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration || { useApifyProxy: false });

    await Actor.charge({ eventName: 'apify-actor-start', count: 1 });

    let auditedCount = 0;
    let opportunityCount = 0;

    // --- Phase 1: Discover URLs via Google if no startUrls ---
    const urlsToAudit = [];

    if (startUrls && startUrls.length > 0) {
        for (const req of startUrls) {
            urlsToAudit.push(typeof req === 'string' ? req : req.url);
        }
        log.info(`Auditing ${urlsToAudit.length} provided URLs.`);
    } else {
        log.info(`No startUrls provided. Auto-discovering "${niche}" businesses${location ? ` in ${location}` : ''}...`);

        const searchQuery = `${niche} ${location} website`.trim();
        const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}&num=50`;

        // Quick Google SERP fetch to discover URLs
        const discoveredUrls = await new Promise((resolve) => {
            const discovered = [];
            const tempCrawler = new CheerioCrawler({
                proxyConfiguration: proxyConfig,
                maxRequestsPerCrawl: 1,
                async requestHandler({ $ }) {
                    $('div.g a[href^="http"]').each((i, el) => {
                        const href = $(el).attr('href');
                        if (href && !href.includes('google.com') && !href.includes('youtube.com')) {
                            try {
                                const domain = new URL(href).hostname;
                                if (!discovered.some(u => u.includes(domain))) {
                                    discovered.push(href);
                                }
                            } catch {}
                        }
                        if (discovered.length >= maxSites) return false;
                    });
                }
            });
            tempCrawler.addRequests([{ url: googleUrl }])
                .then(() => tempCrawler.run())
                .then(() => resolve(discovered))
                .catch(() => resolve(discovered));
        });

        urlsToAudit.push(...discoveredUrls);
        log.info(`Discovered ${urlsToAudit.length} URLs to audit.`);
    }

    if (urlsToAudit.length === 0) {
        log.warning('No URLs to audit. Try providing startUrls or enabling proxy for auto-discovery.');
        await Actor.exit();
        process.exit(0);
    }

    // --- Phase 2: Audit each URL ---
    const crawler = new CheerioCrawler({
        proxyConfiguration: proxyConfig,
        maxConcurrency: 5,
        maxRequestsPerCrawl: maxSites,
        async requestHandler({ request, $, log }) {
            const { signals, opportunity_score } = auditPage($, request.url);

            auditedCount++;

            if (opportunity_score >= minOpportunityScore) {
                const title = $('title').first().text().trim();
                const record = {
                    url: request.url,
                    title,
                    opportunity_score,
                    max_score: 7,
                    signals_triggered: Object.keys(signals).filter(k => signals[k] === true),
                    ...signals,
                    scrapedAt: new Date().toISOString()
                };

                await Actor.pushData(record);
                await Actor.charge({ eventName: 'site-audited', count: 1 });
                opportunityCount++;

                log.info(`🔴 Opportunity (score ${opportunity_score}/7): ${request.url}`);
            } else {
                log.info(`✅ Looks OK (score ${opportunity_score}/7): ${request.url}`);
            }
        },
        async failedRequestHandler({ request }) {
            log.warning(`Failed to audit: ${request.url}`);
        }
    });

    await crawler.addRequests(urlsToAudit.slice(0, maxSites).map(url => ({ url })));
    armKillSwitch(crawler);
    await crawler.run();
    disarmKillSwitch();

    log.info(`🎉 Done! Audited ${auditedCount} sites. Found ${opportunityCount} redesign opportunities!`);
} catch (error) {
    console.error('CRASH:', error);
    throw error;
} finally {
    await Actor.exit();
}
