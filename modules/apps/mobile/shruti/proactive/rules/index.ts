/**
 * Bootstrap point for every proactive rule. Each side-effecting import
 * calls `registerRule()` at load time. The scheduler imports this file
 * once so handlers are resolved by the time it ticks.
 */

import "./enableNotificationsHint.js"
import "./smartLibraryHint.js"
import "./weeklyDigest.js"
import "./inactivity.js"
import "./holiday.js"
