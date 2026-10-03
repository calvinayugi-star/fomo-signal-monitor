// Time-zone helpers for the display time zone (dates, labels, midnights).
function offsetMs(ms, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return Date.UTC(+parts.year, parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - ms;
}

export function makeTime(tz) {
  const localDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d); // YYYY-MM-DD
  return {
    localDate,
    localMonth: (d) => localDate(d).slice(0, 7), // YYYY-MM
    // Midnight in the time zone, as a UTC timestamp. Month 13 rolls into the next year.
    midnight(y, m, d) {
      const guess = Date.UTC(y, m - 1, d);
      return guess - offsetMs(guess - offsetMs(guess, tz), tz);
    },
    when: (d) =>
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZoneName: 'short',
      }).format(d),
    short: (d) =>
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(d),
  };
}
