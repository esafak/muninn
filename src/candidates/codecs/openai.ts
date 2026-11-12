import { z } from "zod"
import { refKey } from "../../model"
import { trackInstruction } from "../constants"
import type { DecisionCodec, JudgeInput } from "../types"

const OpenAIPredicateAnswer = z.object({
  type: z.literal("predicate"),
  name: z.string(),
  probability: z.number().min(0).max(1),
})
const OpenAIResponse = z.object({
  answers: z.array(OpenAIPredicateAnswer),
})

export const openaiCodec: DecisionCodec = {
  id: "openai",
  build: (inputs) => {
    const questionKeys = inputs.map((input) => refKey(input.ref))
    const state = JSON.stringify({
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
    return {
      payload: {
        input: state,
        questions: inputs.map((input) => ({
          type: "predicate",
          name: refKey(input.ref),
          instructions: trackInstruction({
            number: input.ref.number,
            kind: input.ref.kind,
            tier: input.ref.tier,
            snippet: input.snippet,
            command: input.command,
            title: input.title,
            state: input.state,
          }),
        })),
      },
      questionKeys,
    }
  },
  parse: (response, questionKeys) => {
    const parsed = OpenAIResponse.safeParse(response)
    if (!parsed.success) throw new Error(`invalid OpenAI response: ${parsed.error.message}`)
    const byName = new Map(parsed.data.answers.map((a) => [a.name, a.probability]))
    const out: { key: string; probability: number }[] = []
    for (const key of questionKeys) {
      const p = byName.get(key)
      // Unanswered questions are omitted: the caller falls back to keep-all
      // without caching a drop.
      if (p !== undefined) out.push({ key, probability: p })
    }
    return out
  },
}
