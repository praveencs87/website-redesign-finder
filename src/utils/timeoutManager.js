// Auto-Abort Kill Switch for Apify Margins
import { Actor, log } from 'apify';

// 1700s kill switch - leaves 100s buffer before Apify's 1800s hard limit
const KILL_SWITCH_MS = 1700_000;

let stopping = false;
let killTimer = null;

export function shouldStop() {
    return stopping;
}

export function armKillSwitch(crawler) {
    killTimer = setTimeout(async () => {
        log.warning('⏰ Kill-switch fired at ' + (KILL_SWITCH_MS / 1000) + 's to protect PPE margins.');
        stopping = true;

        // Tear down crawler (aborts in-flight requests gracefully)
        if (crawler && typeof crawler.teardown === 'function') {
            await crawler.teardown();
        }

        // Give time for final dataset pushes
        await new Promise(r => setTimeout(r, 2000));

        await Actor.exit({ statusMessage: 'Finished (auto-abort to preserve profit margin)' });
    }, KILL_SWITCH_MS);

    if (killTimer && killTimer.unref) {
        killTimer.unref();
    }
}

export function disarmKillSwitch() {
    if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
    }
}

export function requestStop() {
    stopping = true;
}