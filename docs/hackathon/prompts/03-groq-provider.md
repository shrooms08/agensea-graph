Continue on branch feat/scout in the AgenSea repo. Scout is built and working but Gemini free tier is 20 requests per day per model, which is unusable. Add Groq as a provider and make it the default.

STEP 0. Save this prompt verbatim to docs/hackathon/prompts/03-groq-provider.md and commit "docs: save prompt 03 (groq provider)".

STEP 1. Install @ai-sdk/groq in apps/web. In apps/web/lib/llm.ts add provider "groq" reading GROQ_API_KEY. Pick the current Groq model that supports tool calling and has the highest free-tier daily request limit; check the model list compiled into the installed @ai-sdk/groq package and Groq's published rate limit table, do not guess from memory, and report the id and its daily limit. LLM_MODEL env override must keep working for groq too. Update .env.example with GROQ_API_KEY and note that groq is the recommended provider. .env.local already has GROQ_API_KEY and LLM_PROVIDER=groq set.

STEP 2. Run the three /scout example chips end to end on Groq. Check that emit_verdict is still called exactly once per evaluated agent and that the final plain-language answer still appears. If Groq's model is worse at following the tool protocol (skips emit_verdict, calls it twice, or emits malformed JSON), tighten the system prompt and add a server-side guard that drops duplicate verdicts for the same agentId. Record per-question wall time.

STEP 3. Run typecheck and tests. Commit "feat(scout): Groq provider as default". Do not push.

STEP 4. Report: (a) Groq model id and its free-tier daily request limit, (b) verdict card contents for question 1 and 2 on Groq, (c) wall time per question, (d) any prompt or guard changes you had to make, (e) git log --oneline -3.
