/**
 * date_utils.js
 *
 * Shared date logic for the advance-pickup queue system. Centralized
 * here specifically because the MYT/UTC date relationship is NOT always
 * "same calendar day" — verified before writing this:
 *   21:30 MYT -> 13:30 UTC (same UTC day)
 *   11:00 MYT -> 03:00 UTC (same UTC day)
 *    7:00 MYT -> 23:00 UTC of the PREVIOUS day  <-- the trap
 *
 * nowInMYT() always gives the correct current MYT wall-clock date,
 * regardless of which of the above situations the runner is in.
 */

function nowInMYT() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000);
}

// Formats a Date as DD_Mon_YYYY for bucket filenames. The Date passed in
// should represent the target calendar date via its UTC getters — either
// from nowInMYT() above, or from parsing a plain date-only string like
// "11 Aug 2026" (which JS treats as UTC midnight, so no shift needed).
function formatDateForBucket(date) {
  const day = String(date.getUTCDate()).padStart(2, '0');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[date.getUTCMonth()];
  const year = date.getUTCFullYear();
  return `${day}_${month}_${year}`;
}

// Determines slot (1 = 7AM-12PM, 2 = 1PM-7PM) from a pickup_time string
// like "7:00 AM - 12:00 PM". Returns null if unrecognized.
function slotFromPickupTime(pickupTime) {
  if (!pickupTime) return null;
  // startsWith, not includes — a range like "9:00 AM - 1:00 PM" (old
  // format, no longer valid) isn't either current slot, but a loose
  // .includes() check could still false-match it against '1:00 PM'.
  if (pickupTime.startsWith('7:00 AM')) return 1;
  if (pickupTime.startsWith('1:00 PM')) return 2;
  return null;
}

module.exports = { nowInMYT, formatDateForBucket, slotFromPickupTime };
