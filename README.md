> **⚠ EXPERIMENTAL** — This fork adds a full self-improving AI layer on top of Zoo-Code. All new features are gated behind experiment toggles. Enable at your own risk. PR [#252](https://github.com/Zoo-Code-Org/Zoo-Code/pull/252) contains the complete diff.

Poo-Code is a fork of Zoo-Code which is a fork of Roo-Code which is a fork of Cline. I named it "Poo" because I don't know if it will work or not. In other words, it can either be total sh\*t or become organic fertilizer that will take legacy "spaghetti code" and "crap architectures," breaks them down, and uses full AI automation to fertilize it into beautifully optimized, blooming software to flush out bad code so your codebase can grow.
(The truth is I am too lazy to chunk it into smaller commits — see PR [#252](https://github.com/Zoo-Code-Org/Zoo-Code/pull/252) for the full pile)

---

## The Problem

1. I can't sleep well because of anxiety due to the wrong decisions it made by always selecting the first choice as the answer.
2. It ruined my morning because when I woke up I found it having an unauthorized day off during a busy day (silently stuck because of an error).

The ultimate goal is to totally replace you, so you can be permanently "Ooo" (Out of Office) and jobless like I am.

## What's different from Zoo-Code main

This fork adds **~10,500 lines** of self-improving infrastructure across **45 files** (25 source + 20 test), all behind experiment toggles. Every new feature is gated — Zoo-Code main's behaviour is preserved with everything off.

| Feature                    | Poo-Code (this branch)                                                                                                                                                            | Zoo-Code main                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| **Self-improving loop**    | `SelfImprovingManager` — background review pass every N turns/tool calls. Learns from mistakes, curates skills, suggests optimizations.                                           | ❌ No automated self-review    |
| **Pattern analysis**       | `PatternAnalyzer` — detects recurring tool-use patterns, error signatures, and skill gaps from execution history.                                                                 | ❌ No pattern detection        |
| **Curator service**        | `CuratorService` — tar.gz-backed skill store (backup/rollback). Decides when to create/update/merge skills from learned patterns.                                                 | ❌ Manual skill authoring only |
| **Skill automation**       | `ActionExecutor` + `ImprovementApplier` — auto-creates and updates skills from reviewed patterns.                                                                                 | ❌ No auto skill creation      |
| **Insights engine**        | `InsightsEngine` — generates project-level insights (dead code, stale configs, architecture notes).                                                                               | ❌ No project insights         |
| **Resilience**             | `ResilienceService` — streaming backoff, tool error healer, auto-retry with learned recovery strategies.                                                                          | ❌ Basic retry only            |
| **Question evaluation**    | `QuestionEvaluatorService` — evaluates user questions for clarity/completeness; auto-selects best answer when choices are offered.                                                | ❌ Always picks first choice   |
| **Trust service**          | `TrustService` — learns tool-approval patterns over time. Full-trust mode auto-approves known-safe tools.                                                                         | ❌ Static auto-approval rules  |
| **Review team**            | `ReviewTeamService` — multi-agent review (innovator + critic + decider) scores every learned pattern before applying it.                                                          | ❌ No pre-apply validation     |
| **Agent memory**           | `AgentMemoryAdapter` + `MemoryStore` + `MemoryBackendFactory` — pluggable memory backend (SQLite default, configurable). Bounded context injection via `memory.ts` types.         | ❌ No persistent agent memory  |
| **Learning store**         | `LearningStore` — stores/retrieves learned patterns with confidence scoring. Schema-versioned for forward compat.                                                                 | ❌ No learning storage         |
| **Transcript recall**      | `TranscriptRecall` — retrieves past conversation context for pattern learning.                                                                                                    | ❌ No historical context       |
| **Skill usage tracking**   | `SkillUsageStore` — tracks which skills fire, success rate, frequency. Feeds curator decisions.                                                                                   | ❌ No usage metrics            |
| **Auto-mode orchestrator** | `AutoModeOrchestrator` — automatically switches between VS Code modes based on task type.                                                                                         | ❌ Manual mode switching       |
| **Mode factory**           | `ModeFactoryService` — generates custom modes from learned workflows.                                                                                                             | ❌ Fixed mode set              |
| **Experiment toggles**     | 6 new experiment IDs: `selfImproving`, `selfImprovingAutoSkills`, `selfImprovingAutoMode`, `selfImprovingReviewTeam`, `selfImprovingFullTrust`, `selfImprovingQuestionEvaluation` | ❌ None of these exist         |

### Experiment gate reference

| Toggle                            | Enables                                                      |
| --------------------------------- | ------------------------------------------------------------ |
| `selfImproving`                   | Master switch — enables the entire learning loop             |
| `selfImprovingAutoSkills`         | Auto-create/update/merge skills from learned patterns        |
| `selfImprovingAutoMode`           | Auto-switch VS Code modes based on task                      |
| `selfImprovingReviewTeam`         | Multi-agent review before applying learned patterns          |
| `selfImprovingFullTrust`          | Auto-approve tools that TrustService considers safe          |
| `selfImprovingQuestionEvaluation` | Evaluate user questions for clarity; auto-select best answer |

## Statistic

Projects generated: Countless
Monthly cost: LLM & electric bills
Non-refundable cost: My soul
Revenue generated so far: 0 and still counting zero

## Special Messages

Don't star this repo. It will just get me excited to drag you into the jobless community

Any issue not related to self-learning, submit at https://github.com/Zoo-Code-Org/Zoo-Code/issues as they know more than me (no cap)

## FAQ

**Q:** What is your day job?

**A:** Jobless

**Q:** What is your night job?

**A:** Sleep

**Q:** Ooo... Can I buy you coffee?

**A:** No. I have insomnia.

**Q:** Can I...?

**A:** This is end of conversation.
