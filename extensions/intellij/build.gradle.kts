plugins {
    id("org.jetbrains.intellij.platform") version "2.14.0"
    kotlin("jvm") version "2.1.20"
}

group = "com.claude.code"
version = "0.2.12"

repositories {
    mavenCentral()
    // Aliyun mirrors (uncomment if Maven Central is slow in China)
    // maven { url = uri("https://maven.aliyun.com/repository/central") }
    // maven { url = uri("https://maven.aliyun.com/repository/public") }
    // maven { url = uri("https://maven.aliyun.com/repository/gradle-plugin") }
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        intellijIdeaCommunity("2025.1.4")

        // JCEF is bundled in IntelliJ Runtime — no extra dependency needed
        // WebSocket: use JDK built-in java.net.http.WebSocket (JDK 11+)
    }

    // Gson for JSON handling in WebviewBridge (lightweight, no transitive deps)
    implementation("com.google.code.gson:gson:2.11.0")
}

intellijPlatform {
    buildSearchableOptions = false

    pluginConfiguration {
        ideaVersion {
            sinceBuild = "251"
        }

        changeNotes = """
            <h3>0.2.0 — Context preview, Send File, model profile fix</h3>
            <ul>
                <li>Selection preview: IDE context now sent to webview for live preview</li>
                <li>New "Send File to Claude Code" editor action (Alt+Shift+F)</li>
                <li>Model profile switching now correctly passes env vars to backend</li>
                <li>Fixed WebSocket message delivery (was silently dropping messages)</li>
                <li>IDE context auto-send for active file and selection</li>
                <li>Claude Code chat panel in IDE tool window</li>
                <li>JCEF-based webview with full Claude Code UI</li>
                <li>Backend process management (Bun runtime)</li>
                <li>Model profile switching</li>
                <li>Send selection / Add to chat / Send file context actions</li>
            </ul>
        """.trimIndent()
    }
}

kotlin {
    jvmToolchain(21)
}
