import java.util.Properties
import org.gradle.api.GradleException

plugins {
    id("com.android.application")
}

val releaseProperties = Properties()
val releasePropertiesFile = rootProject.file("qgh-release.properties.local")

if (releasePropertiesFile.isFile) {
    releasePropertiesFile.inputStream().use(releaseProperties::load)
}

val releaseStoreFile = releaseProperties.getProperty("storeFile")
val releaseStorePassword = releaseProperties.getProperty("storePassword")
val releaseKeyAlias = releaseProperties.getProperty("keyAlias")
val releaseKeyPassword = releaseProperties.getProperty("keyPassword")
val hasReleaseSigning = listOf(
    releaseStoreFile,
    releaseStorePassword,
    releaseKeyAlias,
    releaseKeyPassword
).all { !it.isNullOrBlank() }

if (releasePropertiesFile.isFile && !hasReleaseSigning) {
    throw GradleException(
        "qgh-release.properties.local exists but is missing a signing value. " +
            "Use qgh-release.properties.example as the complete template."
    )
}

android {
    namespace = "in.qgh.simulator"
    compileSdk = 36

    defaultConfig {
        applicationId = "in.qgh.simulator"
        minSdk = 26
        targetSdk = 36
        versionCode = 13
        versionName = "4.0.3"
    }

    buildTypes {
        if (hasReleaseSigning) {
            signingConfigs.create("release") {
                storeFile = rootProject.file(requireNotNull(releaseStoreFile))
                storePassword = requireNotNull(releaseStorePassword)
                keyAlias = requireNotNull(releaseKeyAlias)
                keyPassword = requireNotNull(releaseKeyPassword)
            }
        }

        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            signingConfigs.findByName("release")?.let { signingConfig = it }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("androidx.activity:activity:1.13.0")
    implementation("androidx.webkit:webkit:1.17.0")
}

val releaseSigningRequiredTasks = setOf(
    "packageRelease",
    "packageReleaseBundle",
    "signReleaseBundle"
)

tasks.configureEach {
    if (name in releaseSigningRequiredTasks) {
        doFirst {
            check(hasReleaseSigning) {
                "Release signing is required. Create qgh-release.properties.local from " +
                    "qgh-release.properties.example before producing a production artifact."
            }
        }
    }
}
