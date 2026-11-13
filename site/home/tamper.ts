// [CTO] T-098 · the tamper widget's answers: Exam 2's revealed bug titles from Job 1 (recorded run-1.json), shortened to
// bug number and function name (copy v2: "shortened to bug number and function name"). The server hashes the text with
// node:crypto for the no-JS page; the browser recomputes it with crypto.subtle (same text, same SHA-256).
// Skills used: karpathy-guidelines
import type { DemoJob } from "./jobs.ts";

export type KeyRow = [string, string];

/** "Off-by-one in page" -> ["B4", "page"]: the function named after the last " in ". */
export const tamperKey = (J: DemoJob): KeyRow[] => J.bugs.map(([title], i) => [`B${i + 1}`, title.split(" in ").pop() ?? title]);

/** One changed answer: a name no bug has, so the fingerprint can't match. */
export const TAMPER_ROW = 2;
export const TAMPER_VALUE = "restock";

export const tamperText = (key: KeyRow[], exam = "exam 2") => `${exam} answers: ${key.map((r) => r.join(" ")).join(", ")}`;
