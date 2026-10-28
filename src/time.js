const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
});

export function etParts(ms) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
    weekday: p.weekday, // Mon..Sun
  };
}

const OPEN = 9 * 60 + 30;
const CLOSE = 16 * 60;

/** Regular session, Monday to Friday, 9:30-16:00 Eastern. Holidays are not
 *  known here; on a holiday no stock has a fresh trade, so every stock is
 *  skipped as stale and no pick is returned. */
export const inSession = (ms) => {
  const { minutes, weekday } = etParts(ms);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  return minutes >= OPEN && minutes < CLOSE;
};

export const tradeDate = (ms) => etParts(ms).date;
