// The host's bundled taunts, in Thai and English. The deterministic host picks from these; an
// LLM host may write its own.

export type TauntMoment = "start" | "find" | "all-found" | "time-up";

export const TAUNTS: Record<TauntMoment, readonly string[]> = {
    start: [
        "มันอยู่ในนั้นแหละ หาให้เจอสิ",
        "It's in there. Somewhere.",
        "ตาดีได้ ตาร้ายเสีย",
        "Your own doodles are hiding things from you.",
        "แมวไม่ได้หายไปไหน มันแค่ซ่อนเก่ง",
        "Look closer. Closer. No, closer.",
    ],
    find: [
        "เจอแล้ว! ตาไวมาก",
        "Nice spot.",
        "โอ้โห เห็นได้ไง",
        "One less place to hide.",
        "เก่งเกินไปแล้ว",
        "That one was trying so hard.",
    ],
    "all-found": [
        "เจอครบ! รอบหน้าไม่ง่ายแบบนี้แล้วนะ",
        "Nothing escapes you. Next round hides better.",
        "ตาเหยี่ยวชัดๆ",
        "Too easy? Fine. Smaller ones next.",
    ],
    "time-up": [
        "หมดเวลา! มันอยู่ตรงนั้นมาตลอดเลยนะ",
        "Time's up. They were right there.",
        "ไม่เป็นไร แมวมันซ่อนเก่ง",
        "So close. The doodles win this one.",
    ],
};

export function pickTaunt(moment: TauntMoment, random: () => number = Math.random): string {
    const lines = TAUNTS[moment];
    return lines[Math.floor(random() * lines.length) % lines.length];
}
