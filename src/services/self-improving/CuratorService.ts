import * as fs from "fs/promises"
import * as path from "path"
import crypto from "crypto"

import { safeWriteJson } from "../../utils/safeWriteJson"
import type { Logger } from "./types"
import type { SkillTelemetryRecord, SkillUsageStore } from "./SkillUsageStore"

/**
 * Curator configuration
 */
export interface CuratorConfig {
	/** Minimum interval between curator runs (ms) */
	intervalMs: number
	/** Minimum idle time since last user activity before curator runs (ms) */
	minIdleMs: number
	/** Whether to defer the first curator run */
	firstRunDeferred: boolean
	/** Days of inactivity before a skill is marked stale */
	staleAfterDays: number
	/** Days of inactivity before a stale skill is archived */
	archiveAfterDays: number
	/** Whether to create pre-run backups */
	backupsEnabled: boolean
	/** Maximum number of backup snapshots to retain */
	maxBackups: number
}

/**
 * Default curator configuration
 */
export const DEFAULT_CURATOR_CONFIG: CuratorConfig = {
	intervalMs: 3_600_000,
	minIdleMs: 300_000,
	firstRunDeferred: true,
	staleAfterDays: 14,
	archiveAfterDays: 60,
	backupsEnabled: true,
	maxBackups: 5,
}

/**
 * Curator run report
 */
export interface CuratorReport {
	runId: string
	timestamp: number
	durationMs: number
	transitions: Array<{
		skillId: string
		skillName: string
		fromState: string
		toState: string
		reason: string
	}>
	stats: {
		totalSkills: number
		activeSkills: number
		staleSkills: number
		archivedSkills: number
		pinnedSkills: number
		transitionsApplied: number
	}
	backupPath?: string
	error?: string
}

type CuratorStatus = {
	lastRunAt: number
	firstRunDone: boolean
	config: CuratorConfig
}

/**
 * CuratorService — telemetry-driven skill lifecycle management.
 */
export class CuratorService {
	private readonly baseDir: string
	private readonly statePath: string
	private readonly backupsDir: string
	private readonly reportsDir: string
	private readonly skillUsageStore: SkillUsageStore
	private readonly logger: Logger
	private config: CuratorConfig
	private lastRunAt = 0
	private firstRunDone = false
	private initialized = false

	constructor(baseDir: string, skillUsageStore: SkillUsageStore, logger: Logger, config?: Partial<CuratorConfig>) {
		this.baseDir = path.join(baseDir, "self-improving", "curator")
		this.statePath = path.join(this.baseDir, "state.json")
		this.backupsDir = path.join(this.baseDir, "backups")
		this.reportsDir = path.join(this.baseDir, "reports")
		this.skillUsageStore = skillUsageStore
		this.logger = logger
		this.config = { ...DEFAULT_CURATOR_CONFIG, ...config }
	}

	async initialize(): Promise<void> {
		if (this.initialized) {
			return
		}

		try {
			await fs.mkdir(this.backupsDir, { recursive: true })
			await fs.mkdir(this.reportsDir, { recursive: true })
			await this.loadState()
			this.logger.appendLine("[CuratorService] Initialized")
		} catch (error) {
			this.logger.appendLine(
				`[CuratorService] Initialization error: ${error instanceof Error ? error.message : String(error)}`,
			)
		} finally {
			this.initialized = true
		}
	}

	shouldRun(now: number, lastUserActivityAt?: number): boolean {
		if (this.config.firstRunDeferred && !this.firstRunDone && this.lastRunAt === 0) {
			return false
		}

		if (now - this.lastRunAt < this.config.intervalMs) {
			return false
		}

		if (typeof lastUserActivityAt === "number" && now - lastUserActivityAt < this.config.minIdleMs) {
			return false
		}

		return true
	}

	async run(now: number, lastUserActivityAt?: number): Promise<CuratorReport> {
		await this.initialize()

		const startedAt = Date.now()
		const runId = crypto.randomUUID()
		const report: CuratorReport = {
			runId,
			timestamp: now,
			durationMs: 0,
			transitions: [],
			stats: {
				totalSkills: 0,
				activeSkills: 0,
				staleSkills: 0,
				archivedSkills: 0,
				pinnedSkills: 0,
				transitionsApplied: 0,
			},
		}

		try {
			if (this.shouldDeferFirstRun()) {
				this.firstRunDone = true
				await this.saveState()
				report.error = "Skipped: first-run deferral"
				report.durationMs = Date.now() - startedAt
				await this.writeReport(report)
				return report
			}

			if (!this.shouldRun(now, lastUserActivityAt)) {
				report.error = "Skipped: gates not satisfied"
				report.durationMs = Date.now() - startedAt
				await this.writeReport(report)
				return report
			}

			// Set lastRunAt immediately to prevent concurrent runs
			this.lastRunAt = now

			if (this.config.backupsEnabled) {
				report.backupPath = await this.createBackup(runId)
			}

			this.assignStats(report)
			report.transitions = await this.applyDeterministicTransitions()
			await this.runCuratorReview(report)
			report.stats.transitionsApplied = report.transitions.length
			this.assignStats(report)

			this.firstRunDone = true
			await this.saveState()

			report.durationMs = Date.now() - startedAt
			await this.writeReport(report)
			this.logger.appendLine(
				`[CuratorService] Run ${runId}: ${report.transitions.length} transitions in ${report.durationMs}ms`,
			)
		} catch (error) {
			report.error = error instanceof Error ? error.message : String(error)
			report.durationMs = Date.now() - startedAt
			this.logger.appendLine(`[CuratorService] Run error: ${report.error}`)
			await this.writeReport(report)
		}

		return report
	}

	async getLatestReport(): Promise<CuratorReport | null> {
		try {
			const entries = await fs.readdir(this.reportsDir, { withFileTypes: true })
			const candidates = await Promise.all(
				entries
					.filter((entry) => entry.isDirectory())
					.map(async (entry) => {
						const runPath = path.join(this.reportsDir, entry.name, "run.json")
						const stats = await fs.stat(runPath)
						return { runPath, mtimeMs: stats.mtimeMs }
					}),
			)

			if (candidates.length === 0) {
				return null
			}

			candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)
			const raw = await fs.readFile(candidates[0].runPath, "utf-8")
			return JSON.parse(raw) as CuratorReport
		} catch {
			return null
		}
	}

	getConfig(): Readonly<CuratorConfig> {
		return this.config
	}

	setConfig(config: Partial<CuratorConfig>): void {
		this.config = { ...this.config, ...config }
	}

	getStatus(): CuratorStatus {
		return {
			lastRunAt: this.lastRunAt,
			firstRunDone: this.firstRunDone,
			config: { ...this.config },
		}
	}

	private async loadState(): Promise<void> {
		try {
			const raw = await fs.readFile(this.statePath, "utf-8")
			const parsed = JSON.parse(raw) as Partial<CuratorStatus>
			this.lastRunAt = typeof parsed.lastRunAt === "number" ? parsed.lastRunAt : 0
			this.firstRunDone = parsed.firstRunDone === true
		} catch {
			this.lastRunAt = 0
			this.firstRunDone = false
		}
	}

	private async saveState(): Promise<void> {
		try {
			await safeWriteJson(
				this.statePath,
				{
					lastRunAt: this.lastRunAt,
					firstRunDone: this.firstRunDone,
				},
				{ prettyPrint: true },
			)
		} catch (error) {
			this.logger.appendLine(
				`[CuratorService] Save state error: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	private shouldDeferFirstRun(): boolean {
		return this.config.firstRunDeferred && !this.firstRunDone && this.lastRunAt === 0
	}

	private async createBackup(runId: string): Promise<string> {
		const backupDir = path.join(this.backupsDir, `backup-${Date.now()}-${runId}`)
		await fs.mkdir(backupDir, { recursive: true })
		await safeWriteJson(
			path.join(backupDir, "snapshot.json"),
			{
				createdAt: Date.now(),
				curatorState: {
					lastRunAt: this.lastRunAt,
					firstRunDone: this.firstRunDone,
				},
				skillUsage: this.skillUsageStore.getAll(),
			},
			{ prettyPrint: true },
		)
		await this.cleanupOldBackups()
		return backupDir
	}

	private async cleanupOldBackups(): Promise<void> {
		try {
			const entries = await fs.readdir(this.backupsDir, { withFileTypes: true })
			const backups = await Promise.all(
				entries
					.filter((entry) => entry.isDirectory() && entry.name.startsWith("backup-"))
					.map(async (entry) => {
						const backupPath = path.join(this.backupsDir, entry.name)
						const stats = await fs.stat(backupPath)
						return { backupPath, mtimeMs: stats.mtimeMs }
					}),
			)

			backups.sort((left, right) => right.mtimeMs - left.mtimeMs)
			for (const staleBackup of backups.slice(this.config.maxBackups)) {
				await fs.rm(staleBackup.backupPath, { recursive: true, force: true })
			}
		} catch {
			// Best-effort retention cleanup.
		}
	}

	private assignStats(report: CuratorReport): void {
		const stats = this.skillUsageStore.getStats()
		report.stats.totalSkills = stats.total
		report.stats.activeSkills = stats.active
		report.stats.staleSkills = stats.stale
		report.stats.archivedSkills = stats.archived
		report.stats.pinnedSkills = stats.pinned
	}

	private async applyDeterministicTransitions(): Promise<CuratorReport["transitions"]> {
		const transitions: CuratorReport["transitions"] = []

		for (const candidate of this.skillUsageStore.getStaleCandidates(this.config.staleAfterDays)) {
			if (this.isProtected(candidate)) {
				continue
			}

			await this.skillUsageStore.transitionState(candidate.skillId, "stale")
			transitions.push({
				skillId: candidate.skillId,
				skillName: candidate.skillName,
				fromState: "active",
				toState: "stale",
				reason: `No activity for ${this.config.staleAfterDays} days`,
			})
		}

		for (const candidate of this.skillUsageStore.getArchiveCandidates(this.config.archiveAfterDays)) {
			if (this.isProtected(candidate)) {
				continue
			}

			await this.skillUsageStore.transitionState(candidate.skillId, "archived")
			transitions.push({
				skillId: candidate.skillId,
				skillName: candidate.skillName,
				fromState: "stale",
				toState: "archived",
				reason: `No activity for ${this.config.archiveAfterDays} days`,
			})
		}

		return transitions
	}

	private isProtected(record: SkillTelemetryRecord): boolean {
		return record.pinned || record.createdBy !== "agent"
	}

	private async runCuratorReview(_report: CuratorReport): Promise<void> {
		// Reserved for future rubric-driven LLM curator review.
	}

	private async writeReport(report: CuratorReport): Promise<void> {
		try {
			const runDir = path.join(this.reportsDir, report.runId)
			await fs.mkdir(runDir, { recursive: true })
			await safeWriteJson(path.join(runDir, "run.json"), report, { prettyPrint: true })
			await fs.writeFile(path.join(runDir, "REPORT.md"), this.buildReportMarkdown(report), "utf-8")
		} catch (error) {
			this.logger.appendLine(
				`[CuratorService] Report write error: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	private buildReportMarkdown(report: CuratorReport): string {
		const lines = [
			`# Curator Run Report: ${report.runId}`,
			"",
			`**Timestamp**: ${new Date(report.timestamp).toISOString()}`,
			`**Duration**: ${report.durationMs}ms`,
			"",
			"## Summary",
			"",
			"| Metric | Value |",
			"|--------|-------|",
			`| Total Skills | ${report.stats.totalSkills} |`,
			`| Active | ${report.stats.activeSkills} |`,
			`| Stale | ${report.stats.staleSkills} |`,
			`| Archived | ${report.stats.archivedSkills} |`,
			`| Pinned | ${report.stats.pinnedSkills} |`,
			`| Transitions Applied | ${report.stats.transitionsApplied} |`,
			"",
		]

		if (report.transitions.length > 0) {
			lines.push("## Transitions", "", "| Skill | From | To | Reason |", "|-------|------|----|--------|")
			for (const transition of report.transitions) {
				lines.push(
					`| ${transition.skillName} | ${transition.fromState} | ${transition.toState} | ${transition.reason} |`,
				)
			}
			lines.push("")
		}

		if (report.backupPath) {
			lines.push(`**Backup**: ${report.backupPath}`, "")
		}

		if (report.error) {
			lines.push("## Error", "", report.error, "")
		}

		return lines.join("\n")
	}
}
