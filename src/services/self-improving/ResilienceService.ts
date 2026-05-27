import type { Logger } from "./types"

export interface ResilienceConfig {
	enabled: boolean
	maxRetries: number
	baseDelayMs: number
	maxDelayMs: number
	jitterFactor: number
	autoRecover: boolean
	recoveryCommands: string[]
	persistState: boolean
}

export interface RecoveryState {
	consecutiveFailures: number
	lastFailureType: string | null
	lastFailureTime: number | null
	lastSuccessfulTool: string | null
	recoveryAttempts: number
	isInRecoveryMode: boolean
}

const DEFAULT_CONFIG: ResilienceConfig = {
	enabled: true,
	maxRetries: 5,
	baseDelayMs: 2000,
	maxDelayMs: 60000,
	jitterFactor: 0.1,
	autoRecover: true,
	recoveryCommands: [
		"break down the task into smaller steps",
		"simplify the approach",
		"try a different strategy",
		"verify tool parameters before calling",
	],
	persistState: true,
}

export class ResilienceService {
	private logger: Logger
	private config: ResilienceConfig
	private state: RecoveryState

	constructor(logger: Logger, config?: Partial<ResilienceConfig>) {
		this.logger = logger
		this.config = { ...DEFAULT_CONFIG, ...config }
		this.state = this.getInitialState()
	}

	getConfig(): ResilienceConfig {
		return { ...this.config }
	}

	updateConfig(updates: Partial<ResilienceConfig>): void {
		this.config = { ...this.config, ...updates }
		this.logger.appendLine(`[Resilience] Config updated: ${JSON.stringify(updates)}`)
	}

	getState(): RecoveryState {
		return { ...this.state }
	}

	/**
	 * Called when a "having trouble" or streaming failure occurs.
	 * Returns the delay in ms before the next retry, or -1 if max retries exceeded.
	 */
	onStreamingFailure(): number {
		if (!this.config.enabled) {
			return -1
		}

		this.state.consecutiveFailures++
		this.state.lastFailureType = "streaming_failed"
		this.state.lastFailureTime = Date.now()
		this.state.isInRecoveryMode = true

		if (this.state.consecutiveFailures > this.config.maxRetries) {
			this.logger.appendLine(
				`[Resilience] Max retries (${this.config.maxRetries}) exceeded. Entering recovery mode.`,
			)
			return -1 // Signal to enter recovery mode
		}

		const delay = this.calculateBackoff(this.state.consecutiveFailures)
		this.logger.appendLine(
			`[Resilience] Streaming failure #${this.state.consecutiveFailures}. Retrying in ${delay}ms.`,
		)
		return delay
	}

	/**
	 * Called when a tool parameter validation error occurs (e.g., missing required parameter).
	 * Returns a recovery action suggestion or null.
	 */
	onToolParameterError(
		toolName: string,
		missingParam: string,
	): { action: "retry" | "recover" | "abort"; delay?: number; suggestion?: string } | null {
		if (!this.config.enabled) {
			return null
		}

		this.state.consecutiveFailures++
		this.state.lastFailureType = "tool_parameter_error"
		this.state.lastFailureTime = Date.now()
		this.state.lastSuccessfulTool = toolName

		this.logger.appendLine(
			`[Resilience] Tool parameter error: ${toolName} missing '${missingParam}'. Failure #${this.state.consecutiveFailures}.`,
		)

		// Record this as a learning event for the self-improving system
		this.recordToolError(toolName, missingParam)

		if (this.state.consecutiveFailures > this.config.maxRetries) {
			return {
				action: "abort",
				suggestion: `Tool ${toolName} repeatedly missing required parameter '${missingParam}'`,
			}
		}

		const delay = this.calculateBackoff(this.state.consecutiveFailures)
		return {
			action: "retry",
			delay,
			suggestion: `Ensure '${missingParam}' parameter is provided when calling ${toolName}`,
		}
	}

	/**
	 * Called when a task succeeds — resets recovery state.
	 */
	onTaskSuccess(): void {
		if (this.state.consecutiveFailures > 0) {
			this.logger.appendLine(
				`[Resilience] Task succeeded after ${this.state.consecutiveFailures} failures. Resetting state.`,
			)
		}
		this.state = this.getInitialState()
	}

	/**
	 * Get a recovery command suggestion based on current state.
	 */
	getRecoverySuggestion(): string {
		if (!this.state.isInRecoveryMode) {
			return ""
		}

		const index = Math.min(this.state.recoveryAttempts, this.config.recoveryCommands.length - 1)
		this.state.recoveryAttempts++

		const suggestion = this.config.recoveryCommands[index] ?? this.config.recoveryCommands[0]
		return suggestion
	}

	/**
	 * Check if the system is in recovery mode.
	 */
	isInRecoveryMode(): boolean {
		return this.state.isInRecoveryMode
	}

	/**
	 * Exit recovery mode (called when a task succeeds after recovery).
	 */
	exitRecoveryMode(): void {
		this.state.isInRecoveryMode = false
		this.state.recoveryAttempts = 0
		this.logger.appendLine("[Resilience] Exited recovery mode.")
	}

	/**
	 * Record a tool error for the self-improving system to learn from.
	 */
	private recordToolError(toolName: string, missingParam: string): void {
		this.logger.appendLine(`[Resilience] Recording tool error for learning: ${toolName}.${missingParam}`)
	}

	/**
	 * Calculate exponential backoff with jitter.
	 */
	private calculateBackoff(attempt: number): number {
		const exponentialDelay = Math.min(this.config.baseDelayMs * Math.pow(2, attempt - 1), this.config.maxDelayMs)
		const jitter = exponentialDelay * this.config.jitterFactor * Math.random()
		return Math.floor(exponentialDelay + jitter)
	}

	private getInitialState(): RecoveryState {
		return {
			consecutiveFailures: 0,
			lastFailureType: null,
			lastFailureTime: null,
			lastSuccessfulTool: null,
			recoveryAttempts: 0,
			isInRecoveryMode: false,
		}
	}

	getStatus(): Record<string, any> {
		return {
			enabled: this.config.enabled,
			maxRetries: this.config.maxRetries,
			autoRecover: this.config.autoRecover,
			consecutiveFailures: this.state.consecutiveFailures,
			isInRecoveryMode: this.state.isInRecoveryMode,
			lastFailureType: this.state.lastFailureType,
			recoveryAttempts: this.state.recoveryAttempts,
		}
	}
}
