import * as fs from "fs/promises"
import * as path from "path"
import type { Logger } from "./types"

/** Describes a detected project language / tech stack */
export interface ProjectProfile {
	language: string
	buildCommand?: string
	lintCommand?: string
	typeCheckCommand?: string
	testCommand?: string
}

export interface VerificationResult {
	passed: boolean
	gates: Array<{
		name: string
		passed: boolean
		output?: string
		error?: string
		durationMs: number
	}>
	summary: string
}

export interface VerificationConfig {
	/** Whether to run build check */
	checkBuild: boolean
	/** Whether to run lint check */
	checkLint: boolean
	/** Whether to run type check */
	checkTypes: boolean
	/** Whether to run tests */
	checkTests: boolean
	/** Build command (e.g., "npm run build") */
	buildCommand?: string
	/** Lint command (e.g., "npm run lint") */
	lintCommand?: string
	/** Type check command (e.g., "npm run typecheck") */
	typeCheckCommand?: string
	/** Test command (e.g., "npm test") */
	testCommand?: string
	/** Working directory for verification commands */
	cwd?: string
	/** Timeout per gate in ms */
	gateTimeoutMs: number
	/** Whether verification is mandatory (blocks completion) */
	mandatory: boolean
}

const DEFAULT_CONFIG: VerificationConfig = {
	checkBuild: false,
	checkLint: false,
	checkTypes: false,
	checkTests: false,
	gateTimeoutMs: 60_000,
	mandatory: true,
}

/**
 * Map of well-known project files to their language profile.
 * Uses the most-specific match first (prefers sub-stack over generic).
 */
const LANG_SIGNATURES: Array<{
	files: string[]
	fn: (cwd: string) => Promise<ProjectProfile | null>
}> = [
	// --- Node / JS/TS ---
	{
		files: ["package.json", "tsconfig.json", "next.config.js", "nuxt.config.ts", "svelte.config.js"],
		fn: async (cwd) => {
			const hasPackage = await fileExists(cwd, "package.json")
			if (!hasPackage) return null
			const hasTS = await fileExists(cwd, "tsconfig.json")
			const hasBuildScript = await hasScript(cwd, "build")
			const hasLintScript = await hasScript(cwd, "lint")
			const hasTypeCheckScript =
				(await hasScript(cwd, "typecheck")) ||
				(await hasScript(cwd, "type-check")) ||
				(await hasScript(cwd, "types"))
			const hasTestScript = await hasScript(cwd, "test")
			return {
				language: hasTS ? "TypeScript" : "JavaScript",
				buildCommand: hasBuildScript ? "npm run build" : undefined,
				lintCommand: hasLintScript ? "npm run lint" : undefined,
				typeCheckCommand: hasTypeCheckScript
					? (await hasScript(cwd, "typecheck"))
						? "npm run typecheck"
						: (await hasScript(cwd, "type-check"))
							? "npm run type-check"
							: "npm run types"
					: hasTS
						? "npx tsc --noEmit"
						: undefined,
				testCommand: hasTestScript ? "npm test" : undefined,
			}
		},
	},
	// --- Rust ---
	{
		files: ["Cargo.toml"],
		fn: async () => ({
			language: "Rust",
			buildCommand: "cargo build",
			lintCommand: "cargo clippy",
			typeCheckCommand: "cargo check",
			testCommand: "cargo test",
		}),
	},
	// --- Python ---
	{
		files: ["pyproject.toml", "setup.py", "setup.cfg", "Pipfile", "requirements.txt"],
		fn: async (cwd) => {
			const hasPyProject = await fileExists(cwd, "pyproject.toml")
			const hasBlack = (await fileExists(cwd, ".flake8")) || (await fileExists(cwd, "pyproject.toml"))
			const hasMypy =
				(await fileExists(cwd, "mypy.ini")) ||
				(await fileExists(cwd, ".mypy.ini")) ||
				(await fileExists(cwd, "pyproject.toml")) // mypy can be in pyproject
			const hasPytest =
				(await fileExists(cwd, "pytest.ini")) ||
				(await fileExists(cwd, "pyproject.toml")) ||
				(await fileExists(cwd, "setup.cfg"))
			const isPdm = await fileExists(cwd, "pyproject.toml")
			const hasBuildScript = isPdm ? await hasScriptPython(cwd, "build") : false
			return {
				language: "Python",
				buildCommand: isPdm && hasBuildScript ? "pdm build" : undefined,
				lintCommand: hasBlack ? "flake8 ." : undefined,
				typeCheckCommand: hasMypy ? "mypy ." : undefined,
				testCommand: hasPytest ? "pytest" : "python -m unittest",
			}
		},
	},
	// --- Go ---
	{
		files: ["go.mod"],
		fn: async () => ({
			language: "Go",
			buildCommand: "go build ./...",
			lintCommand: "go vet ./...",
			typeCheckCommand: undefined, // Go type-checks at compile time
			testCommand: "go test ./...",
		}),
	},
	// --- Java / Gradle ---
	{
		files: ["build.gradle", "build.gradle.kts", "gradlew", "pom.xml"],
		fn: async (cwd) => {
			const isGradle = (await fileExists(cwd, "gradlew")) || (await fileExists(cwd, "build.gradle"))
			const isMaven = await fileExists(cwd, "pom.xml")
			if (isGradle) {
				return {
					language: "Java (Gradle)",
					buildCommand: "./gradlew build",
					lintCommand: "./gradlew check",
					typeCheckCommand: undefined,
					testCommand: "./gradlew test",
				}
			}
			if (isMaven) {
				return {
					language: "Java (Maven)",
					buildCommand: "mvn compile",
					lintCommand: "mvn checkstyle:check",
					typeCheckCommand: undefined,
					testCommand: "mvn test",
				}
			}
			return null
		},
	},
	// --- Ruby ---
	{
		files: ["Gemfile"],
		fn: async (cwd) => {
			const hasRubocop = await fileExists(cwd, ".rubocop.yml")
			return {
				language: "Ruby",
				buildCommand: "bundle exec rake",
				lintCommand: hasRubocop ? "bundle exec rubocop" : undefined,
				typeCheckCommand: (await fileExists(cwd, "rbs")) ? "bundle exec rbs validate" : undefined,
				testCommand: "bundle exec rspec",
			}
		},
	},
	// --- Elixir ---
	{
		files: ["mix.exs"],
		fn: async () => ({
			language: "Elixir",
			buildCommand: "mix compile",
			lintCommand: "mix credo",
			typeCheckCommand: undefined,
			testCommand: "mix test",
		}),
	},
	// --- Deno ---
	{
		files: ["deno.json", "deno.jsonc"],
		fn: async () => ({
			language: "Deno",
			buildCommand: "deno check",
			lintCommand: "deno lint",
			typeCheckCommand: "deno check",
			testCommand: "deno test",
		}),
	},
	// --- .NET / C# ---
	{
		files: ["*.csproj"],
		fn: async () => ({
			language: "C#",
			buildCommand: "dotnet build",
			lintCommand: "dotnet format --verify-no-changes",
			typeCheckCommand: undefined,
			testCommand: "dotnet test",
		}),
	},
	// --- Zig ---
	{
		files: ["build.zig"],
		fn: async () => ({
			language: "Zig",
			buildCommand: "zig build",
			lintCommand: "zig fmt --check",
			typeCheckCommand: "zig build",
			testCommand: "zig test",
		}),
	},
]

async function fileExists(dir: string, name: string): Promise<boolean> {
	try {
		await fs.access(path.join(dir, name))
		return true
	} catch {
		return false
	}
}

/** Check if package.json has a specific script defined */
async function hasScript(cwd: string, scriptName: string): Promise<boolean> {
	try {
		const content = await fs.readFile(path.join(cwd, "package.json"), "utf-8")
		const pkg = JSON.parse(content)
		return !!(pkg.scripts && pkg.scripts[scriptName])
	} catch {
		return false
	}
}

/** Check if pyproject.toml has a tool.*.scripts entry */
async function hasScriptPython(cwd: string, _scriptName: string): Promise<boolean> {
	try {
		const content = await fs.readFile(path.join(cwd, "pyproject.toml"), "utf-8")
		return content.includes("[project.scripts]") || content.includes("build-backend")
	} catch {
		return false
	}
}

export class VerificationEngine {
	private config: VerificationConfig
	private lastVerifyAt?: number
	private lastResult?: VerificationResult
	private enabled: boolean
	private autoProfiled: ProjectProfile | null = null

	constructor(
		private readonly logger?: Logger,
		config?: Partial<VerificationConfig>,
		enabled: boolean = true,
	) {
		this.config = { ...DEFAULT_CONFIG, ...config }
		this.enabled = enabled
	}

	/**
	 * Auto-detect the project language profile from the working directory.
	 * Detects Node/JS/TS, Rust, Python, Go, Java/Gradle, Ruby, Elixir, Deno, C#, Zig.
	 * Returns null if no known project files are found.
	 */
	async autoDetectProject(cwd?: string): Promise<ProjectProfile | null> {
		const dir = cwd || this.config.cwd || process.cwd()
		for (const sig of LANG_SIGNATURES) {
			for (const filePattern of sig.files) {
				if (filePattern.includes("*")) {
					// Glob-like — check if any file matches
					try {
						const entries = await fs.readdir(dir)
						const match = entries.find((e) => e.endsWith(filePattern.slice(1)))
						if (match) {
							const profile = await sig.fn(dir)
							if (profile) {
								this.autoProfiled = profile
								this.logger?.appendLine(
									`[VerificationEngine] Auto-detected project: ${profile.language} (from ${match})`,
								)
								return profile
							}
						}
					} catch {
						continue
					}
				} else {
					if (await fileExists(dir, filePattern)) {
						const profile = await sig.fn(dir)
						if (profile) {
							this.autoProfiled = profile
							this.logger?.appendLine(
								`[VerificationEngine] Auto-detected project: ${profile.language} (from ${filePattern})`,
							)
							return profile
						}
					}
				}
			}
		}
		this.logger?.appendLine("[VerificationEngine] No recognizable project files detected")
		return null
	}

	/**
	 * Fill gaps in the current config from the auto-detected profile.
	 * Explicitly-set config values take precedence (not overwritten).
	 */
	async applyAutoProfile(cwd?: string): Promise<void> {
		const profile = await this.autoDetectProject(cwd)
		if (!profile) return

		if (!this.config.buildCommand && profile.buildCommand) {
			this.config.buildCommand = profile.buildCommand
			this.config.checkBuild = true
		}
		if (!this.config.lintCommand && profile.lintCommand) {
			this.config.lintCommand = profile.lintCommand
			this.config.checkLint = true
		}
		if (!this.config.typeCheckCommand && profile.typeCheckCommand) {
			this.config.typeCheckCommand = profile.typeCheckCommand
			this.config.checkTypes = true
		}
		if (!this.config.testCommand && profile.testCommand) {
			this.config.testCommand = profile.testCommand
			this.config.checkTests = true
		}

		this.logger?.appendLine(
			`[VerificationEngine] Auto-config applied: build=${
				this.config.checkBuild ? this.config.buildCommand : "off"
			}, lint=${this.config.checkLint ? this.config.lintCommand : "off"}, types=${
				this.config.checkTypes ? this.config.typeCheckCommand : "off"
			}, tests=${this.config.checkTests ? this.config.testCommand : "off"}`,
		)
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled
		this.logger?.appendLine(`[VerificationEngine] ${enabled ? "Enabled" : "Disabled"}`)
	}

	updateConfig(config: Partial<VerificationConfig>): void {
		this.config = { ...this.config, ...config }
		this.logger?.appendLine(`[VerificationEngine] Config updated: ${JSON.stringify(config)}`)
	}

	getConfig(): VerificationConfig {
		return { ...this.config }
	}

	getStatus(): Record<string, unknown> {
		if (!this.enabled) {
			return { enabled: false, gates: [] }
		}
		return {
			enabled: true,
			lastVerifyAt: this.lastVerifyAt,
			lastResult: this.lastResult,
			autoProfiled: this.autoProfiled,
		}
	}

	async verify(): Promise<VerificationResult> {
		const gates: VerificationResult["gates"] = []

		if (this.config.checkBuild && this.config.buildCommand) {
			gates.push(await this.runGate("build", this.config.buildCommand))
		}

		if (this.config.checkLint && this.config.lintCommand) {
			gates.push(await this.runGate("lint", this.config.lintCommand))
		}

		if (this.config.checkTypes && this.config.typeCheckCommand) {
			gates.push(await this.runGate("type-check", this.config.typeCheckCommand))
		}

		if (this.config.checkTests && this.config.testCommand) {
			gates.push(await this.runGate("tests", this.config.testCommand))
		}

		const passed = gates.every((g) => g.passed)
		const failedGates = gates.filter((g) => !g.passed)

		let summary: string
		if (gates.length === 0) {
			summary = "No verification gates configured"
		} else if (passed) {
			summary = `All ${gates.length} verification gates passed`
		} else {
			summary = `${failedGates.length}/${gates.length} gates failed: ${failedGates.map((g) => g.name).join(", ")}`
		}

		this.logger?.appendLine(`[VerificationEngine] ${summary}`)

		this.lastVerifyAt = Date.now()
		this.lastResult = { passed, gates, summary }

		return { passed, gates, summary }
	}

	/**
	 * Check whether a valid package.json exists in the configured cwd.
	 * Falls back to process.cwd() if config.cwd is not set.
	 */
	private async isCwdValid(): Promise<boolean> {
		try {
			const cwd = this.config.cwd || (await this.findProjectRoot()) || process.cwd()
			const packageJsonPath = path.join(cwd, "package.json")
			await fs.access(packageJsonPath)
			return true
		} catch {
			return false
		}
	}

	/**
	 * Walk up from the configured cwd (or process.cwd()) looking for
	 * any recognized project root marker (Cargo.toml, pyproject.toml, go.mod, etc.).
	 * Falls back to first directory containing package.json.
	 */
	private async findProjectRoot(): Promise<string | undefined> {
		const cwd = this.config.cwd || process.cwd()
		let current = path.resolve(cwd)
		const root = path.parse(current).root

		while (current !== root) {
			try {
				const entries = await fs.readdir(current)
				const markers = [
					"package.json",
					"Cargo.toml",
					"pyproject.toml",
					"go.mod",
					"Gemfile",
					"mix.exs",
					"deno.json",
					"deno.jsonc",
					"build.zig",
					"build.gradle",
					"pom.xml",
				]
				for (const marker of markers) {
					if (entries.includes(marker)) {
						return current
					}
				}
			} catch {
				// directory inaccessible, keep walking up
			}
			current = path.dirname(current)
		}
		// Check root too
		try {
			const entries = await fs.readdir(root)
			for (const marker of ["package.json", "Cargo.toml", "pyproject.toml", "go.mod"]) {
				if (entries.includes(marker)) {
					return root
				}
			}
		} catch {
			// ignore
		}
		return undefined
	}

	private async runGate(name: string, command: string): Promise<VerificationResult["gates"][0]> {
		const start = Date.now()

		// Run gate with auto-discovered cwd
		try {
			const cwd = this.config.cwd || (await this.findProjectRoot()) || process.cwd()
			const resolvedCwd = cwd

			// Use dynamic import for child_process
			const { execSync } = await import("child_process")

			const output = execSync(command, {
				cwd: resolvedCwd,
				timeout: this.config.gateTimeoutMs,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			})

			const durationMs = Date.now() - start
			this.logger?.appendLine(`[VerificationEngine] Gate "${name}" passed (${durationMs}ms)`)
			return { name, passed: true, output: output.slice(0, 1000), durationMs }
		} catch (error: any) {
			const durationMs = Date.now() - start
			const errorMsg = error?.stderr || error?.stdout || error?.message || String(error)
			this.logger?.appendLine(
				`[VerificationEngine] Gate "${name}" FAILED (${durationMs}ms): ${errorMsg.slice(0, 200)}`,
			)
			return {
				name,
				passed: false,
				error: errorMsg.slice(0, 1000),
				durationMs,
			}
		}
	}
}
