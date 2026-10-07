/**
 * One stored instant as local date and time, with the time zone named.
 *
 * UnodeAi stores every instant in UTC. Chat is shown on the person's own machine, so a card there states an
 * instant in that machine's time zone and names the zone; exported evidence keeps the stored UTC text and says
 * that it is UTC. The two never show a bare time that could be read as either.
 *
 * This function is written into the Chat webview's script as source text, so it uses nothing outside its own
 * body. Returns an empty string for a value that is not an instant: the caller then shows the stored text.
 */
export function formatLocalInstant(instant: unknown, locale?: string, timeZone?: string): string {
  if (typeof instant !== 'string') return '';
  const when = new Date(instant);
  if (Number.isNaN(when.getTime())) return '';
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZoneName: 'short',
  };
  if (timeZone) options.timeZone = timeZone;
  try {
    return new Intl.DateTimeFormat(locale, options).format(when);
  } catch {
    return '';
  }
}
