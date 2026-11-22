import type { AppSettings } from '../shared/protocol';
import { parseIssuePattern, safeHttpUrl, validateUrlTemplate, type IssuePattern } from './settings-schema';

export type MessageToken =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'bold' | 'italic' | 'bolditalic'; children: MessageToken[] }
  | { kind: 'link'; url: string; children: MessageToken[] };
export type MessageSettings = Pick<AppSettings, 'markdown' | 'emoji' | 'customEmoji' | 'issueUrl' | 'issueRules'>;

/** Independently maintained Unicode-only map. No image service or downloaded emoji table is used. */
export const GITMOJI: Readonly<Record<string, string>> = Object.freeze({
  art: '🎨', zap: '⚡', fire: '🔥', bug: '🐛', ambulance: '🚑', sparkles: '✨', memo: '📝',
  rocket: '🚀', lipstick: '💄', tada: '🎉', white_check_mark: '✅', lock: '🔒', closed_lock_with_key: '🔐',
  bookmark: '🔖', rotating_light: '🚨', construction: '🚧', green_heart: '💚', arrow_down: '⬇️',
  arrow_up: '⬆️', pushpin: '📌', construction_worker: '👷', chart_with_upwards_trend: '📈', recycle: '♻️',
  heavy_plus_sign: '➕', heavy_minus_sign: '➖', wrench: '🔧', hammer: '🔨', globe_with_meridians: '🌐',
  pencil2: '✏️', poop: '💩', hankey: '💩', shit: '💩', rewind: '⏪', twisted_rightwards_arrows: '🔀',
  package: '📦', alien: '👽', truck: '🚚', page_facing_up: '📄', boom: '💥', collision: '💥', bento: '🍱',
  wheelchair: '♿', bulb: '💡', beers: '🍻', speech_balloon: '💬', card_file_box: '🗃️', loud_sound: '🔊',
  mute: '🔇', busts_in_silhouette: '👥', children_crossing: '🚸', building_construction: '🏗️', iphone: '📱',
  clown_face: '🤡', egg: '🥚', see_no_evil: '🙈', camera_flash: '📸', alembic: '⚗️', mag: '🔍', label: '🏷️',
  seedling: '🌱', triangular_flag_on_post: '🚩', goal_net: '🥅', dizzy: '💫', wastebasket: '🗑️',
  passport_control: '🛂', adhesive_bandage: '🩹', monocle_face: '🧐', coffin: '⚰️', test_tube: '🧪',
  necktie: '👔', stethoscope: '🩺', bricks: '🧱', technologist: '🧑‍💻', money_with_wings: '💸',
  thread: '🧵', safety_vest: '🦺', airplane: '✈️', '1234': '🔢', '+1': '👍', '-1': '👎',
  thumbsup: '👍', thumbsdown: '👎', smile: '😄', smiling_face: '☺️', grinning: '😀', grin: '😁', joy: '😂',
  rofl: '🤣', wink: '😉', blush: '😊', heart_eyes: '😍', thinking: '🤔', thinking_face: '🤔',
  sunglasses: '😎', neutral_face: '😐', confused: '😕', worried: '😟', cry: '😢', sob: '😭', angry: '😠',
  rage: '😡', scream: '😱', sleeping: '😴', sweat_smile: '😅', laughing: '😆', slight_smile: '🙂',
  slightly_smiling_face: '🙂', upside_down_face: '🙃', expressionless: '😑', zipper_mouth_face: '🤐',
  nerd_face: '🤓', facepalm: '🤦', shrug: '🤷', pray: '🙏', clap: '👏', raised_hands: '🙌', wave: '👋',
  ok_hand: '👌', muscle: '💪', v: '✌️', point_right: '👉', point_left: '👈', point_up: '☝️', point_down: '👇',
  heart: '❤️', orange_heart: '🧡', yellow_heart: '💛', blue_heart: '💙', purple_heart: '💜', black_heart: '🖤',
  white_heart: '🤍', broken_heart: '💔', star: '⭐', star2: '🌟', eyes: '👀', brain: '🧠', handshake: '🤝',
  checkered_flag: '🏁', warning: '⚠️', x: '❌', heavy_check_mark: '✔️', question: '❓', exclamation: '❗',
  information_source: 'ℹ️', no_entry: '⛔', no_entry_sign: '🚫', stop_sign: '🛑', '100': '💯',
  coffee: '☕', tea: '🍵', beer: '🍺', pizza: '🍕', cake: '🍰', birthday: '🎂', cookie: '🍪', apple: '🍎',
  snake: '🐍', penguin: '🐧', whale: '🐳', dolphin: '🐬', cat: '🐱', dog: '🐶', octopus: '🐙', unicorn: '🦄',
  turtle: '🐢', snail: '🐌', rabbit: '🐇', racehorse: '🐎', bee: '🐝', butterfly: '🦋', ant: '🐜', spider: '🕷️',
  sun_with_face: '🌞', sunny: '☀️', cloud: '☁️', snowflake: '❄️', rainbow: '🌈', earth_americas: '🌎',
  earth_africa: '🌍', earth_asia: '🌏', crescent_moon: '🌙', comet: '☄️', volcano: '🌋', ocean: '🌊',
  computer: '💻', desktop_computer: '🖥️', keyboard: '⌨️', gear: '⚙️', electric_plug: '🔌', battery: '🔋',
  link: '🔗', paperclip: '📎', scissors: '✂️', folder: '📁', file_folder: '📁', open_file_folder: '📂',
  books: '📚', book: '📖', notebook: '📓', pencil: '📝', pen: '🖊️', paintbrush: '🖌️', palette: '🎨',
  key: '🔑', old_key: '🗝️', shield: '🛡️', tools: '🛠️', toolbox: '🧰', hammer_and_wrench: '🛠️',
  hourglass: '⌛', hourglass_flowing_sand: '⏳', stopwatch: '⏱️', alarm_clock: '⏰', clock1: '🕐',
  bell: '🔔', no_bell: '🔕', megaphone: '📣', loudspeaker: '📢', email: '📧', envelope: '✉️', inbox_tray: '📥',
  outbox_tray: '📤', mailbox: '📫', satellite: '📡', robot: '🤖', robot_face: '🤖', ghost: '👻', skull: '💀',
  skull_and_crossbones: '☠️', trophy: '🏆', medal: '🏅', first_place_medal: '🥇', second_place_medal: '🥈',
  third_place_medal: '🥉', gem: '💎', crown: '👑', gift: '🎁', balloon: '🎈', confetti_ball: '🎊',
  tada_ball: '🎉', circus_tent: '🎪', dart: '🎯', jigsaw: '🧩', game_die: '🎲', video_game: '🎮',
  chart: '💹', bar_chart: '📊', chart_with_downwards_trend: '📉', straight_ruler: '📏', triangular_ruler: '📐',
  compass: '🧭', world_map: '🗺️', mountain: '⛰️', camping: '🏕️', house: '🏠', office: '🏢', hospital: '🏥',
  factory: '🏭', school: '🏫', bank: '🏦', bridge_at_night: '🌉', railway_track: '🛤️', car: '🚗', bus: '🚌',
  train: '🚋', airplane_departure: '🛫', airplane_arriving: '🛬', ship: '🚢', sailboat: '⛵', anchor: '⚓',
  traffic_light: '🚥', vertical_traffic_light: '🚦', check: '✓', infinity: '♾️', white_circle: '⚪',
  black_circle: '⚫', red_circle: '🔴', blue_circle: '🔵', large_green_circle: '🟢', large_yellow_circle: '🟡',
  large_orange_circle: '🟠', large_purple_circle: '🟣', large_brown_circle: '🟤',
});

export function expandEmoji(text: string, custom: Record<string, string> = {}): string {
  return text.replace(/:([a-z\d_+-]{1,80}):/gi, (match, name: string) => {
    const key = name.toLowerCase();
    const value = Object.prototype.hasOwnProperty.call(custom, name) ? custom[name] : Object.prototype.hasOwnProperty.call(custom, `:${name}:`) ? custom[`:${name}:`] : Object.prototype.hasOwnProperty.call(custom, key) ? custom[key] : GITMOJI[key];
    return typeof value === 'string' && value.length <= 100 && !/[\u0000-\u001f\u007f]/.test(value) ? value : match;
  });
}
export const expandGitmoji = expandEmoji;
interface IssueMatcher { pattern: IssuePattern; url: string }
const isWord = (character: string | undefined): boolean => Boolean(character && /[a-z\d_]/i.test(character));
function issueAt(text: string, at: number, pattern: IssuePattern): { end: number; id: string } | null {
  if (pattern.start && at !== 0 || !text.startsWith(pattern.prefix, at)) return null;
  const digitStart = at + pattern.prefix.length; let end = digitStart;
  while (end < text.length && end - digitStart < 64 && text.charCodeAt(end) >= 48 && text.charCodeAt(end) <= 57) end++;
  if (end === digitStart || end < text.length && /\d/.test(text[end]) || !text.startsWith(pattern.suffix, end)) return null;
  const matchEnd = end + pattern.suffix.length;
  if (pattern.end && matchEnd !== text.length || pattern.boundaryStart && isWord(text[at - 1]) === isWord(text[at]) || pattern.boundaryEnd && isWord(text[matchEnd - 1]) === isWord(text[matchEnd])) return null;
  return { end: matchEnd, id: text.slice(digitStart, end) };
}
function issueUrl(template: string, id: string, match: string): string | null {
  if (!validateUrlTemplate(template, undefined, false)) {
    return safeHttpUrl(template.replace(/\{(id|match|commit|branch)\}/g, (_value, name: string) => encodeURIComponent(name === 'id' ? id : name === 'match' ? match : '')));
  }
  return null;
}
function httpAt(text: string, start: number): { end: number; url: string } | null {
  if (isWord(text[start - 1]) || !/^https?:\/\//i.test(text.slice(start, start + 8))) return null;
  let end = start;
  while (end < text.length && end - start < 8192 && !/[\s<>"'`]/.test(text[end])) end++;
  if (end - start >= 8192) return null;
  while (end > start && /[.,;:!?]/.test(text[end - 1])) end--;
  for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
    const candidate = text.slice(start, end); let balance = 0;
    for (const character of candidate) if (character === open) balance++; else if (character === close) balance--;
    while (balance < 0 && text[end - 1] === close) { end--; balance++; }
  }
  const url = safeHttpUrl(text.slice(start, end)); return url ? { end, url } : null;
}
/** Bounded inline parser. Untrusted text is never HTML. Unknown constructs remain literal text. */
export function tokenizeMessage(text: string, settings: MessageSettings, inline = false): MessageToken[] {
  const matchers: IssueMatcher[] = [];
  for (const rule of (settings.issueRules ?? []).slice(0, 30)) {
    const pattern = parseIssuePattern(rule.pattern); if (pattern && !validateUrlTemplate(rule.url, undefined, false)) matchers.push({ pattern, url: rule.url });
  }
  if (settings.issueUrl && !validateUrlTemplate(settings.issueUrl)) matchers.push({ pattern: { prefix: '#', suffix: '', boundaryStart: false, boundaryEnd: false, start: false, end: false }, url: settings.issueUrl });
  let budget = 4096; let work = 1_000_000;
  function find(source: string, needle: string, from: number, maximum: number): number {
    const window = source.slice(from, from + maximum);
    const result = window.indexOf(needle); work -= result < 0 ? window.length : result + needle.length;
    return result < 0 ? -1 : from + result;
  }
  function parse(source: string, depth: number, links: boolean): MessageToken[] {
    const tokens: MessageToken[] = []; let plain = ''; let at = 0;
    const flush = (): void => { if (!plain) return; const value = settings.emoji ? expandEmoji(plain, settings.customEmoji) : plain; const last = tokens[tokens.length - 1]; if (last?.kind === 'text') last.text += value; else tokens.push({ kind: 'text', text: value }); plain = ''; };
    while (at < source.length) {
      if (budget <= 0 || work <= 0) { plain += source.slice(at); break; }
      work--;
      const char = source[at]; const rest = source.slice(at, at + 8);
      if (settings.markdown && char === '\\' && at + 1 < source.length && '\\`*_[]()'.includes(source[at + 1])) { plain += source[at + 1]; at += 2; continue; }
      if (settings.markdown && char === '`') {
        let size = 1; while (size < 8 && source[at + size] === '`') size++;
        if (size < 8) {
          const marker = '`'.repeat(size); const end = find(source, marker, at + size, 4096);
          if (end >= at + size && end - at <= 4096 && !source.slice(at, end).includes('\n')) {
            flush(); tokens.push({ kind: 'code', text: source.slice(at + size, end) }); budget--; at = end + size; continue;
          }
        }
      }
      if (settings.markdown && links && char === '[') {
        const close = find(source, '](', at + 1, 1024);
        if (close > at && close - at <= 1024) {
          let end = close + 2; let balance = 1;
          while (end < source.length && end - close <= 4096 && !/\s/.test(source[end]) && balance && work > 0) { work--; if (source[end] === '(') balance++; else if (source[end] === ')') balance--; if (balance) end++; }
          if (!balance) {
            const url = safeHttpUrl(source.slice(close + 2, end));
            if (url) { flush(); tokens.push({ kind: 'link', url, children: depth < 6 ? parse(source.slice(at + 1, close), depth + 1, false) : [{ kind: 'text', text: source.slice(at + 1, close) }] }); budget--; at = end + 1; continue; }
            // An unsafe Markdown link remains one literal construct; it cannot become a clickable partial URL.
            plain += source.slice(at, end + 1); at = end + 1; continue;
          }
        }
      }
      if (links && (rest.toLowerCase().startsWith('https://') || rest.toLowerCase().startsWith('http://'))) {
        const link = httpAt(source, at);
        if (link) { flush(); tokens.push({ kind: 'link', url: link.url, children: [{ kind: 'text', text: source.slice(at, link.end) }] }); budget--; at = link.end; continue; }
      }
      if (settings.markdown && depth < 6 && (char === '*' || char === '_') && !(char === '_' && isWord(source[at - 1]))) {
        let count = 1; while (count < 3 && source[at + count] === char) count++;
        const marker = char.repeat(count); const end = find(source, marker, at + count, 4096);
        if (end > at + count && end - at <= 4096 && !/\s/.test(source[at + count]) && !/\s/.test(source[end - 1]) && !(char === '_' && isWord(source[end + count])) && !source.slice(at, end).includes('\n')) {
          flush(); const kind = count === 3 ? 'bolditalic' : count === 2 ? 'bold' : 'italic';
          tokens.push({ kind, children: parse(source.slice(at + count, end), depth + 1, links) }); budget--; at = end + count; continue;
        }
      }
      if (links) {
        let found = false;
        for (const rule of matchers) {
          if (!rule.pattern.prefix && !/\d/.test(char)) continue;
          if (rule.pattern.prefix && rule.pattern.prefix[0] !== char) continue;
          if (rule.pattern.prefix === '#' && isWord(source[at - 1])) continue;
          const match = issueAt(source, at, rule.pattern);
          if (!match) continue;
          const url = issueUrl(rule.url, match.id, source.slice(at, match.end));
          if (!url) continue;
          flush(); tokens.push({ kind: 'link', url, children: [{ kind: 'text', text: source.slice(at, match.end) }] }); budget--; at = match.end; found = true; break;
        }
        if (found) continue;
      }
      plain += char; at++;
    }
    flush(); return tokens;
  }
  // Parsing work is bounded independently of commit body size; untouched tail is still displayed verbatim.
  const limit = inline ? 16384 : 131072;
  const tokens = parse(text.slice(0, limit), 0, true);
  if (text.length > limit) tokens.push({ kind: 'text', text: text.slice(limit) });
  return tokens;
}
export const parseMessage = tokenizeMessage;
