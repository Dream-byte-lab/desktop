// The composer's raw material. The old greeting had five sentences;
// this file holds the PARTS of hundreds — openers, middles and closers
// per time-of-day band — which compose.ts assembles multiplicatively
// (openers x weaves x middles x closers x structures), further
// multiplied by live context lines (weekday, season, streak, return).
// Nothing here is a finished greeting; variety comes from assembly.

import type { GreetingBandId } from "./greeting";

export interface Opener {
  text: string;
  /** True when "{opener} to you, {name}" reads naturally. */
  salutation?: boolean;
  /** True when the opener is a question (ends in "?"). */
  question?: boolean;
}

export interface BandParts {
  openers: Opener[];
  middles: string[];
  closers: string[];
}

const S = (text: string): Opener => ({ text, salutation: true });
const O = (text: string): Opener => ({ text });
const Q = (text: string): Opener => ({ text, question: true });

export const BAND_PARTS: Record<GreetingBandId, BandParts> = {
  morning: {
    openers: [
      S("Good morning"),
      S("Morning"),
      O("Rise and shine"),
      O("A fresh day, a fresh queue"),
      O("The day is young and so is the playlist"),
      O("First coffee, first song"),
      O("Early notes hit different"),
      O("Here's to a loud morning"),
      O("Here's to a quiet morning"),
      O("New day, new soundtrack"),
      O("The sun beat you to it — barely"),
      Q("Ready for some morning music?"),
      Q("Shall we start the day properly?"),
      O("Morning has broken — in a good way"),
      O("Daylight and downbeats"),
      O("Up and at 'em"),
    ],
    middles: [
      "Let's ease into the day.",
      "Start soft, finish loud.",
      "Something gentle to open with?",
      "The day sounds better already.",
      "Pick a first track that means it.",
      "Slow starts make strong days.",
      "Your morning, your tempo.",
      "Let the first song set the tone.",
      "Coffee's better with a chorus.",
      "A little momentum before the world wakes up.",
      "Yesterday's last song is today's warm-up.",
      "Begin as you mean to go on — playing.",
      "The early hours have the clearest sound.",
      "One good song and the day is underway.",
    ],
    closers: [
      "Make it count.",
      "Off we go.",
      "Turn it up a notch.",
      "You've got this.",
      "One song at a time.",
      "Let it play.",
      "Start it right.",
      "Go gently, play loudly.",
    ],
  },
  midday: {
    openers: [
      S("Happy lunch"),
      S("Good midday"),
      O("Lunch-hour listening"),
      O("Halfway through the day"),
      O("The midday break sounds good"),
      O("A pause, with music"),
      O("Midday, and the queue is calling"),
      O("Time out, tunes on"),
      O("The day's intermission"),
      Q("Hungry for food or for music first?"),
      O("A breather between the halves"),
      O("Midday reset, incoming"),
      O("Lunch tastes better with a beat"),
      O("The noon hour, well spent"),
    ],
    middles: [
      "A good moment for a breather.",
      "Refuel — ears included.",
      "Twenty minutes of music counts as lunch, right?",
      "The afternoon goes better after a song.",
      "Take the break properly: press play.",
      "Half the day down, all the songs ahead.",
      "A pause is part of the music too.",
      "Eat something, hear something.",
      "Midday songs carry the afternoon.",
      "Stretch, breathe, listen.",
      "The day's middle is a fine place for a favourite.",
      "Recharge at full volume, or close to it.",
    ],
    closers: [
      "Then back at it.",
      "Afternoon, handled.",
      "One more track won't hurt.",
      "Fuel up.",
      "Make the break count.",
      "You've earned it.",
      "Back to it — eventually.",
      "Dessert is a song, surely.",
    ],
  },
  afternoon: {
    openers: [
      S("Good afternoon"),
      S("Afternoon"),
      O("The long stretch of the day"),
      O("Afternoon, amplified"),
      O("Past the halfway mark"),
      O("The day's second wind starts here"),
      O("Sun's still up, so are we"),
      O("Afternoon hours, evening energy"),
      Q("Tea, coffee, or just a chorus?"),
      O("Keep the afternoon honest"),
      O("The home stretch has a soundtrack"),
      O("Golden hour is warming up"),
      O("Afternoon, but make it music"),
      O("Still daylight, still playing"),
    ],
    middles: [
      "Keep the day moving.",
      "The afternoon slump doesn't stand a chance.",
      "Steady beats for steady hours.",
      "Something with legs for the long stretch.",
      "You're closer to the evening than you think.",
      "Let a good chorus do the heavy lifting.",
      "The day improves at this volume.",
      "Workday or not, the music doesn't mind.",
      "A favourite track is an afternoon strategy.",
      "Keep going — the playlist has you.",
      "This is the part of the day music was invented for.",
      "Momentum, but make it melodic.",
    ],
    closers: [
      "Nearly there.",
      "Keep it rolling.",
      "Evening's coming.",
      "Stay with it.",
      "One track closer.",
      "The day's not done yet.",
      "Finish strong.",
      "Carry on playing.",
    ],
  },
  evening: {
    openers: [
      S("Good evening"),
      S("Evening"),
      O("The day is done — the music isn't"),
      O("Evening, at last"),
      O("Time to unwind — or turn it up"),
      O("The best hours start now"),
      O("Lights low, volume honest"),
      O("After-hours, your hours"),
      Q("Unwind, or turn it up tonight?"),
      O("The evening set begins"),
      O("Dinner, then dancing — or just dancing"),
      O("Golden hour, golden oldies, or something new"),
      O("The day was the warm-up"),
      O("Evening suits you"),
    ],
    middles: [
      "Time to unwind — or turn it up.",
      "The evening is yours; spend it loudly.",
      "Whatever the day was, this part is yours.",
      "Put the day down and the volume up.",
      "Favourite songs earn their keep at this hour.",
      "Slow ones, loud ones — dealer's choice.",
      "The night is young and the queue is long.",
      "Let the evening sound like you want it to feel.",
      "A proper evening starts with a proper first track.",
      "Company or solitude, music fits both.",
      "The day's noise stops here; yours starts.",
      "This is prime listening time. Use it.",
    ],
    closers: [
      "Enjoy every track.",
      "Make a night of it.",
      "The night is young.",
      "Play it like you mean it.",
      "Here's to the evening.",
      "Let it run long.",
      "No curfew on choruses.",
      "Settle in.",
    ],
  },
  latenight: {
    openers: [
      S("Up late"),
      O("The quiet hours have the best songs"),
      O("Night owl hours"),
      O("Still up — respect"),
      O("The small hours, the big songs"),
      O("Midnight's gone; the music hasn't"),
      O("For the ones still awake"),
      O("The night shift of listening"),
      O("Everyone else is asleep. Their loss"),
      Q("One more song before sleep?"),
      O("Deep night, deep cuts"),
      O("The world is quiet; your speakers don't have to be"),
      O("Late is just early for tomorrow's music"),
      O("Insomnia, but make it a playlist"),
    ],
    middles: [
      "The quiet hours have the best songs.",
      "Low volume, high feeling.",
      "Night listening is a different sport.",
      "The songs sound closer at this hour.",
      "No skips at 2 a.m. — house rules.",
      "Let it play soft and mean it.",
      "This is when the deep cuts come out.",
      "Sleep can wait for the chorus.",
      "The dark makes a fine listening room.",
      "One more album won't hurt. Probably.",
      "Headphones were invented for this exact hour.",
      "Tomorrow can deal with tomorrow.",
    ],
    closers: [
      "Sleep well, eventually.",
      "Just one more.",
      "The night is listening too.",
      "Dream in stereo.",
      "Last one — maybe.",
      "Keep it low, keep it going.",
      "Until the birds start.",
      "Night, for now.",
    ],
  },
};

/** Closers shared by every band, added to each band's own pool. */
export const SHARED_CLOSERS: string[] = [
  "Press play.",
  "Your move.",
  "Let the music talk.",
  "Sound on.",
  "Here's to the next track.",
  "Enjoy.",
  "As always — good taste.",
  "The queue awaits.",
];

/** Weekday lines (index 0 = Sunday), used as observations or middles. */
export const WEEKDAY_LINES: string[][] = [
  [
    "Sunday pace: slow songs welcome.",
    "A Sunday well spent starts with a song.",
  ],
  ["Monday, but with music — better already.", "New week. New first track."],
  [
    "Tuesday: the week's most underrated playlist day.",
    "Tuesday grooves are real grooves.",
  ],
  ["Wednesday — the week's halfway chorus.", "Midweek, mid-tempo, no problem."],
  [
    "Thursday: Friday is warming up in the wings.",
    "Nearly the weekend. Sounds like it too.",
  ],
  [
    "Friday, finally. The week's best opener.",
    "It's Friday — the volume rules relax.",
  ],
  ["Saturday, and the day is wide open.", "Weekend rules: there are none."],
];

/** Season lines for the northern-hemisphere calendar the app already uses. */
export const SEASON_LINES: Record<string, string[]> = {
  spring: [
    "Spring in the air, spring in the step.",
    "New season, new rotation.",
  ],
  summer: [
    "Summer rules: windows down, volume up.",
    "Long days deserve long playlists.",
  ],
  autumn: ["Autumn sounds good on you.", "Sweater weather, headphone weather."],
  winter: [
    "Cold outside, warm speakers.",
    "Winter listening is serious listening.",
  ],
};

/** Observations for a listener on a consecutive-day streak (uses {streak}). */
export const STREAK_LINES: string[] = [
  "{streak} days in a row",
  "Day {streak} of the streak",
  "{streak} days running — the streak is alive",
  "Back again: day {streak} straight",
];

/** Observations for a returning listener (gap since the last session). */
export const RETURN_LINES: string[] = [
  "Welcome back",
  "It's been a little while",
  "Look who's back",
  "The speakers missed you",
];

export const LONG_RETURN_LINES: string[] = [
  "It's been a while — welcome back",
  "Long time no listen",
  "The library kept your seat warm",
];

/** Observations when this is NOT the first open of the day. */
export const AGAIN_LINES: string[] = [
  "Back for more",
  "Once wasn't enough today",
  "Again — good",
  "Round two (or three) today",
];

/** Observations for the very first greeting this listener ever gets. */
export const FIRST_EVER_LINES: string[] = [
  "Welcome — first of many",
  "Hello, and welcome",
  "Your first greeting of many",
];
