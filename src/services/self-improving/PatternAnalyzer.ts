import crypto from "crypto"

import type { LearnedPattern, LearningEvent } from "./types"

/**
 * PatternAnalyzer - extracts learned patterns from event streams
 * using deterministic heuristics (frequency analysis, correction tracking,
 * success correlation).
 *
 * Adapted from Hermes' symbolic pattern extraction approach.
 */
export class PatternAnalyzer {
	/**
	 * Analyze a batch of events and return new/updated patterns.
	 * This is the main entry point called during review cycles.
	 */
	analyze(events: LearningEvent[], existingPatterns: LearnedPattern[]): LearnedPattern[] {
		const patterns: LearnedPattern[] = []
		const now = Date.now()

		const correctionPatterns = this.extractCorrectionPatterns(events, existingPatterns, now)
		patterns.push(...correctionPatterns)

		const successPatterns = this.extractSuccessPatterns(events, existingPatterns, now)
		patterns.push(...successPatterns)

		const toolPatterns = this.extractToolPatterns(events, existingPatterns, now)
		patterns.push(...toolPatterns)

		const codeIndexPatterns = this.extractCodeIndexPatterns(events, existingPatterns, now)
		patterns.push(...codeIndexPatterns)

		return patterns
	}

	/**
	 * Extract error-avoidance patterns from correction/failure events.
	 */
	private extractCorrectionPatterns(
		events: LearningEvent[],
		existingPatterns: LearnedPattern[],
		now: number,
	): LearnedPattern[] {
		const patterns: LearnedPattern[] = []
		const correctionEvents = events.filter(
			(event) =>
				event.signal === "USER_CORRECTION" || (event.signal === "TASK_FAILURE" && event.outcome.corrected),
		)

		const byErrorKey = new Map<string, LearningEvent[]>()
		for (const event of correctionEvents) {
			const key = event.context.errorKey || "unknown"
			const bucket = byErrorKey.get(key) ?? []
			bucket.push(event)
			byErrorKey.set(key, bucket)
		}

		for (const [errorKey, errorEvents] of byErrorKey) {
			const frequency = errorEvents.length
			const existing = existingPatterns.find(
				(pattern) => pattern.patternType === "error" && pattern.context.errorKeys?.includes(errorKey),
			)

			if (existing) {
				patterns.push({
					...existing,
					frequency: existing.frequency + frequency,
					lastSeenAt: now,
					confidenceScore: Math.min(1, existing.confidenceScore + frequency * 0.05),
					successRate: Math.max(0, existing.successRate - frequency * 0.02),
				})
			} else if (frequency >= 2) {
				patterns.push({
					id: crypto.randomUUID(),
					patternType: "error",
					state: "active",
					summary: `Avoid: repeated ${errorKey} errors detected`,
					confidenceScore: Math.min(0.5, frequency * 0.1),
					frequency,
					successRate: 0.3,
					firstSeenAt: now,
					lastSeenAt: now,
					sourceSignals: ["USER_CORRECTION", "TASK_FAILURE"],
					context: {
						errorKeys: [errorKey],
						toolNames: this.collectToolNames(errorEvents),
					},
				})
			}
		}

		return patterns
	}

	/**
	 * Extract success patterns from task success events.
	 */
	private extractSuccessPatterns(
		events: LearningEvent[],
		existingPatterns: LearnedPattern[],
		now: number,
	): LearnedPattern[] {
		const patterns: LearnedPattern[] = []
		const successEvents = events.filter((event) => event.signal === "TASK_SUCCESS")

		if (successEvents.length < 3) {
			return patterns
		}

		const byToolSet = new Map<string, LearningEvent[]>()
		for (const event of successEvents) {
			const toolKey = [...(event.context.toolNames ?? [])].sort().join(",")
			if (!toolKey) {
				continue
			}

			const bucket = byToolSet.get(toolKey) ?? []
			bucket.push(event)
			byToolSet.set(toolKey, bucket)
		}

		for (const [toolKey, toolEvents] of byToolSet) {
			const frequency = toolEvents.length
			const existing = existingPatterns.find(
				(pattern) => pattern.patternType === "tool" && this.hasMatchingToolNames(pattern, toolKey.split(",")),
			)

			if (existing) {
				patterns.push({
					...existing,
					frequency: existing.frequency + frequency,
					lastSeenAt: now,
					confidenceScore: Math.min(1, existing.confidenceScore + frequency * 0.03),
					successRate: Math.min(1, existing.successRate + frequency * 0.02),
				})
			} else if (frequency >= 3) {
				patterns.push({
					id: crypto.randomUUID(),
					patternType: "tool",
					state: "active",
					summary: `Effective tool combination: ${toolKey}`,
					confidenceScore: Math.min(0.6, frequency * 0.1),
					frequency,
					successRate: 0.7,
					firstSeenAt: now,
					lastSeenAt: now,
					sourceSignals: ["TASK_SUCCESS"],
					context: {
						toolNames: toolKey.split(","),
					},
				})
			}
		}

		return patterns
	}

	/**
	 * Extract tool preference patterns.
	 */
	private extractToolPatterns(
		events: LearningEvent[],
		existingPatterns: LearnedPattern[],
		now: number,
	): LearnedPattern[] {
		const patterns: LearnedPattern[] = []
		const toolCounts = new Map<string, { success: number; failure: number }>()

		for (const event of events) {
			for (const toolName of event.context.toolNames ?? []) {
				const counts = toolCounts.get(toolName) ?? { success: 0, failure: 0 }
				if (event.signal === "TASK_SUCCESS") {
					counts.success++
				} else if (event.signal === "TASK_FAILURE") {
					counts.failure++
				}
				toolCounts.set(toolName, counts)
			}
		}

		for (const [toolName, counts] of toolCounts) {
			const total = counts.success + counts.failure
			if (total < 3) {
				continue
			}

			const successRate = counts.success / total
			const existing = existingPatterns.find(
				(pattern) => pattern.patternType === "prompt" && this.hasMatchingToolNames(pattern, [toolName]),
			)

			if (existing) {
				const combinedFrequency = existing.frequency + total
				const existingSuccesses = existing.successRate * existing.frequency
				const combinedSuccessRate = (existingSuccesses + counts.success) / combinedFrequency

				patterns.push({
					...existing,
					frequency: combinedFrequency,
					lastSeenAt: now,
					successRate: combinedSuccessRate,
					confidenceScore: Math.min(1, existing.confidenceScore + 0.02),
				})
			} else if (successRate > 0.7) {
				patterns.push({
					id: crypto.randomUUID(),
					patternType: "prompt",
					state: "active",
					summary: `Prefer ${toolName} for reliable results`,
					confidenceScore: Math.min(0.5, successRate * 0.5),
					frequency: total,
					successRate,
					firstSeenAt: now,
					lastSeenAt: now,
					sourceSignals: ["TASK_SUCCESS"],
					context: {
						toolNames: [toolName],
					},
				})
			}
		}

		return patterns
	}

	/**
	 * Extract code index correlation patterns.
	 */
	private extractCodeIndexPatterns(
		events: LearningEvent[],
		existingPatterns: LearnedPattern[],
		now: number,
	): LearnedPattern[] {
		const codeIndexEvents = events.filter((event) => event.signal === "CODE_INDEX_HIT")
		if (codeIndexEvents.length < 3) {
			return []
		}

		const totalHits = codeIndexEvents.reduce((sum, event) => sum + (event.context.codeIndex?.hits ?? 0), 0)
		const averageHits = totalHits / codeIndexEvents.length
		if (averageHits <= 0) {
			return []
		}

		const summary = `Code indexing correlates with task outcomes (avg ${averageHits.toFixed(1)} hits/event)`
		const existing = existingPatterns.find(
			(pattern) => pattern.patternType === "code-index" && pattern.summary === summary,
		)

		if (existing) {
			return [
				{
					...existing,
					frequency: existing.frequency + codeIndexEvents.length,
					lastSeenAt: now,
					confidenceScore: Math.min(1, existing.confidenceScore + averageHits * 0.01),
				},
			]
		}

		return [
			{
				id: crypto.randomUUID(),
				patternType: "code-index",
				state: "active",
				summary,
				confidenceScore: Math.min(0.5, averageHits * 0.05),
				frequency: codeIndexEvents.length,
				successRate: 0.6,
				firstSeenAt: now,
				lastSeenAt: now,
				sourceSignals: ["CODE_INDEX_HIT"],
				context: {},
			},
		]
	}

	/**
	 * Collect unique tool names from a set of events.
	 */
	private collectToolNames(events: LearningEvent[]): string[] {
		const names = new Set<string>()
		for (const event of events) {
			for (const name of event.context.toolNames ?? []) {
				names.add(name)
			}
		}

		return [...names]
	}

	private hasMatchingToolNames(pattern: LearnedPattern, toolNames: string[]): boolean {
		const existingToolNames = pattern.context.toolNames
		if (!existingToolNames || existingToolNames.length !== toolNames.length) {
			return false
		}

		const normalizedExisting = [...existingToolNames].sort()
		const normalizedIncoming = [...toolNames].sort()

		return normalizedExisting.every((toolName, index) => toolName === normalizedIncoming[index])
	}
}
