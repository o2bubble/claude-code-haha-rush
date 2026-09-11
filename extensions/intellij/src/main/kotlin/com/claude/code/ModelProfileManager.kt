package com.claude.code

import com.google.gson.Gson
import com.google.gson.JsonParser
import java.io.File

/**
 * Manages model profile discovery, switching, and persistence.
 *
 * This is a direct translation of VS Code provider.ts:253-393.
 * All logic is preserved 1:1.
 *
 * Profiles are stored as .env files under .env.profiles/ in the repo root.
 * The active profile is persisted to ~/.claude/ide-profile.env (IDE-specific,
 * isolated from the CLI's .env). The active profile name is stored in
 * ~/.claude/ide-profile.active.
 *
 * Env vars managed by profiles (cleaned up before applying a new one):
 *   ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL,
 *   ANTHROPIC_MODEL, ANTHROPIC_DEFAULT_*_MODEL, ANTHROPIC_SMALL_FAST_MODEL,
 *   ANTHROPIC_CUSTOM_MODEL_OPTION, API_TIMEOUT_MS, MAX_TOKENS,
 *   CLAUDE_CODE_MAX_OUTPUT_TOKENS, CLAUDE_CODE_MAX_CONTEXT_TOKENS,
 *   DISABLE_TELEMETRY, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
 *   CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK, CLAUDE_CODE_VIRTUAL_SCROLL_THRESHOLD,
 *   CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_USE_VERTEX, CLAUDE_CODE_USE_FOUNDRY
 */
class ModelProfileManager(
    private val ideScriptPath: String,
    private val projectBasePath: String?
) {
    private val gson = Gson()

    companion object {
        val PROFILE_KEYS = setOf(
            "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL",
            "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "ANTHROPIC_DEFAULT_MODEL", "ANTHROPIC_SMALL_FAST_MODEL",
            "ANTHROPIC_CUSTOM_MODEL_OPTION", "API_TIMEOUT_MS", "MAX_TOKENS",
            "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
            "DISABLE_TELEMETRY", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
            "CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK",
            "CLAUDE_CODE_VIRTUAL_SCROLL_THRESHOLD",
            "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
            "CLAUDE_CODE_USE_FOUNDRY"
        )
    }

    // Env var keys managed by profile switching (mirrors VS Code provider.ts:94-116)
    private val profileManagedKeys = PROFILE_KEYS

    // ── Public API ──────────────────────────────────────────────────────

    /**
     * Restore profile env vars from project-level .claude/settings.local.json
     * to System properties before spawning the backend.
     */
    fun restoreIdeProfile() {
        val wsRoot = projectBasePath ?: return
        val localSettingsFile = File(wsRoot, ".claude/settings.local.json")
        if (!localSettingsFile.exists()) return
        try {
            val raw = gson.fromJson(localSettingsFile.readText(Charsets.UTF_8), Map::class.java)
            val env = raw?.get("env") as? Map<*, *> ?: return
            for (key in profileManagedKeys) {
                System.clearProperty(key)
            }
            for ((key, value) in env) {
                if (value is String) System.setProperty(key as String, value)
            }
        } catch (_: Exception) {}
    }

    /**
     * Build the model_profiles payload for the webview.
     * Searches .env.profiles/ in: repoRoot → extensionRoot → projectRoot.
     *
     * @return JSON string like {"type":"model_profiles","profiles":[...],"active":"..."}
     */
    fun getModelProfilesJson(): String {
        val profilesDir = getProfilesDir()
        if (profilesDir == null || !profilesDir.exists() || !profilesDir.isDirectory) {
            return """{"type":"model_profiles","profiles":[],"active":null}"""
        }

        val profiles = mutableListOf<Map<String, String>>()
        val entries = profilesDir.listFiles() ?: emptyArray()
        for (entry in entries) {
            if (!entry.name.endsWith(".env")) continue
            val id = entry.name.removeSuffix(".env")
            try {
                val content = entry.readText(Charsets.UTF_8)
                val env = parseEnvFile(content)
                profiles.add(
                    mapOf(
                        "id" to id,
                        "label" to id,
                        "model" to (env["ANTHROPIC_MODEL"]
                            ?: env["ANTHROPIC_DEFAULT_SONNET_MODEL"]
                            ?: "")
                    )
                )
            } catch (_: Exception) { /* skip invalid env files */ }
        }

        // Read active profile from project-level .claude/active-profile
        val projectActivePath = projectBasePath?.let { File(it, ".claude/active-profile") }
        val active = if (projectActivePath?.exists() == true) {
            projectActivePath.readText(Charsets.UTF_8).trim()
        } else null

        val result = mapOf(
            "type" to "model_profiles",
            "profiles" to profiles,
            "active" to active
        )
        return gson.toJson(result)
    }

    /**
     * Switch to a different model profile.
     * Mirrors VS Code provider.ts:351-393.
     *
     * 1. Clean stale profile-managed env vars
     * 2. Read new profile's .env file
     * 3. Set new env vars on System properties
     * 4. Persist to project-level .claude/settings.local.json env section
     * 5. Save active profile name
     * 6. Return the profile ID for frontend notification
     * 7. Caller is responsible for: interrupt → restart backend
     */
    fun switchProfile(profileId: String): String? {
        val profilesDir = getProfilesDir()
            ?: return """{"error":"Cannot find profiles directory"}"""

        val profilePath = File(profilesDir, "$profileId.env")
        if (!profilePath.exists()) {
            return """{"error":"Profile not found: $profileId"}"""
        }

        try {
            val content = profilePath.readText(Charsets.UTF_8)
            val env = parseEnvFile(content)

            // 1. Clean stale profile-managed env vars
            for (key in profileManagedKeys) {
                System.clearProperty(key)
            }

            // 2. Set new profile vars
            for ((key, value) in env) {
                System.setProperty(key, value)
            }

            // 3. Persist to project-level .claude/settings.local.json env section
            val base = projectBasePath
            if (base != null) {
                val claudeDir = File(base, ".claude")
                if (!claudeDir.exists()) claudeDir.mkdirs()
                val localSettingsFile = File(claudeDir, "settings.local.json")
                @Suppress("UNCHECKED_CAST")
                val existing = try {
                    gson.fromJson(localSettingsFile.readText(Charsets.UTF_8), MutableMap::class.java) as? MutableMap<String, Any>
                } catch (_: Exception) { null } ?: mutableMapOf()
                val envSection = (existing["env"] as? MutableMap<String, String>) ?: mutableMapOf()
                for (key in profileManagedKeys) {
                    envSection.remove(key)
                }
                for ((key, value) in env) {
                    envSection[key] = value
                }
                existing["env"] = envSection
                localSettingsFile.writeText(gson.toJson(existing) + "\n", Charsets.UTF_8)
                // Write active profile marker
                File(claudeDir, "active-profile").writeText(profileId, Charsets.UTF_8)
            }

            // Return success payload (include model name so webview label updates immediately)
            val modelName = env["ANTHROPIC_MODEL"] ?: env["ANTHROPIC_DEFAULT_SONNET_MODEL"] ?: ""
            return gson.toJson(mapOf("type" to "model_profile_changed", "profile" to profileId, "model" to modelName))
        } catch (e: Exception) {
            return """{"error":"Failed to switch profile: ${e.message}"}"""
        }
    }

    // ── File Paths ──────────────────────────────────────────────────────

    /**
     * Find .env.profiles/ directory.
     * Priority: repoRoot → extensionRoot → projectRoot
     * Mirrors VS Code provider.ts:282-301.
     */
    private fun getProfilesDir(): File? {
        // Priority 1: repoRoot derived from claude-ide script path
        val repoRoot = File(ideScriptPath).parentFile?.parentFile
        if (repoRoot != null) {
            val rp = File(repoRoot, ".env.profiles")
            if (rp.exists()) return rp
        }

        // Priority 2: Extension install location
        val extRoot = try {
            val url = javaClass.classLoader.getResource("META-INF/plugin.xml")
            if (url != null) {
                var path = url.path.removeSuffix("/META-INF/plugin.xml")
                if (path.startsWith("/") && path.length > 2 && path[2] == ':') {
                    path = path.substring(1)
                }
                File(path).parentFile?.parentFile // up to resources root
            } else null
        } catch (_: Exception) { null }
        if (extRoot != null) {
            val ep = File(extRoot, ".env.profiles")
            if (ep.exists()) return ep
        }

        // Priority 3: Project workspace root
        if (projectBasePath != null) {
            val wp = File(projectBasePath, ".env.profiles")
            if (wp.exists()) return wp
        }

        // Priority 4: user home (global profiles created by claude-profile / gui-profile.py)
        val homeProfiles = File(System.getProperty("user.home"), ".claude/.env.profiles")
        if (homeProfiles.exists()) return homeProfiles

        return null
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    /** Parse a simple .env file (KEY=VALUE, # comments) */
    private fun parseEnvFile(content: String): Map<String, String> {
        val result = mutableMapOf<String, String>()
        for (rawLine in content.lines()) {
            val line = rawLine.trim()
            if (line.isEmpty() || line.startsWith("#")) continue
            val eqIdx = line.indexOf('=')
            if (eqIdx <= 0) continue
            val key = line.substring(0, eqIdx)
            val value = line.substring(eqIdx + 1)
            result[key] = value
        }
        return result
    }
}
