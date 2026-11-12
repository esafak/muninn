import { z } from "zod"
import { refKey } from "../../model"
import { trackInstruction } from "../constants"
import type { DecisionCodec, JudgeInput } from "../types"

const JevNoulAnswer = z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) })
const JevResponse = z.object({
  model: z.string().optional(),
  answers: z.record(z.string(), JevNoulAnswer),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).partial().optional(),
})

const stateFor = (inputs: readonly JudgeInput[]) => ({
  task: "Decide which session references merit tracking in pill and sidebar. Mentioned or encountered is not enough.",
  candidates: inputs.map((input) => ({
    key: refKey(input.ref),
    kind: input.ref.kind ?? "unknown",
    number: input.ref.number,
    tier: input.ref.tier,
    command: input.command ?? null,
    snippet: input.snippet.slice(0, 800),
    title: input.title ?? null,
    state: input.state ?? null,
  })),
})

export const jevCodec: DecisionCodec = {
  id: "jev",
  build: (inputs) => {
    const questionKeys = inputs.map((input) => refKey(input.ref))
    const questions: Record<string, { type: "noul"; instructions: string }> = {}
    inputs.forEach((input) => {
      questions[refKey(input.ref)] = {
        type: "noul",
        instructions: trackInstruction({
          number: input.ref.number,
          kind: input.ref.kind,
          tier: input.ref.tier,
          snippet: input.snippet,
          command: input.command,
          title: input.title,
          state: input.state,
        }),
      }
    })
    return { payload: { state: stateFor(inputs), questions }, questionKeys }
  },
  parse: (response, questionKeys) => {
    const parsed = JevResponse.safeParse(response)
    if (!parsed.success) throw new Error(`invalid Jev response: ${parsed.error.message}`)
    const out: { key: string; probability: number }[] = []
    for (const key of questionKeys) {
      const answer = parsed.data.answers[key]
      // Unanswered questions are omitted: the caller falls back to keep-all
      // without caching a drop. A Noul near 0.5 is uncertainty, not intensity.
      if (answer !== undefined) out.push({ key, probability: answer.noul })
    }
    return out
  },
}
