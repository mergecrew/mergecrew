# Stack cookbook: Java

Default workspace image: [`ghcr.io/mergecrew/runner-java:21`](22-runner-images.md). Carries Temurin 21 + Maven 3.9 + Gradle 8.

## Detection signals

The runner picks the Java stack on any of:

| File | Build system |
| --- | --- |
| `pom.xml` | Maven |
| `build.gradle` / `build.gradle.kts` / `gradlew` | Gradle (wrapper preferred) |

Gradle detection prefers `./gradlew` over the system `gradle` so the project's pinned Gradle distribution wins.

## Default build commands

### Maven

| Skill | Command |
| --- | --- |
| install | `mvn -B -q dependency:resolve` |
| typecheck | `mvn -B -q compile` |
| lint | `mvn -B -q spotless:check` |
| test | `mvn -B -q test` |
| integration | `mvn -B -q verify` |

### Gradle

| Skill | Command |
| --- | --- |
| install | `./gradlew dependencies` |
| typecheck | `./gradlew check -x test` |
| lint | `./gradlew spotlessCheck` |
| test | `./gradlew test` |
| integration | `./gradlew integrationTest` |

## Common overrides

Most Java overrides come from non-standard task names — corporate projects routinely rename `test` to `unitTest`, or skip the spotless plugin altogether.

```yaml
# mergecrew.yaml
runner:
  image: ghcr.io/mergecrew/runner-java:21
  resources: { cpu: 4, memory: 8Gi, timeout: 30m }
build:
  commands:
    # Project uses Checkstyle instead of Spotless
    lint: { cmd: "./gradlew", args: ["checkstyleMain"] }
    # Slow integration suite — skip in the daily run; require human gate
    integration: { cmd: "./gradlew", args: ["smokeTest"] }
```

Pin a specific JDK via `.tool-versions`:

```
# .tool-versions
java temurin-21.0.5+11
```

## Common gotchas

- **Gradle daemon.** The default container is ephemeral; Gradle's daemon doesn't survive between runs. The `--no-daemon` flag is implicit because `./gradlew` doesn't see a daemon process to attach to. Net: cold-start is dominated by the first dependency resolution, not by JVM warmup.
- **Maven settings.xml.** Custom mirror configuration goes in the workspace's `.mvn/settings.xml`, not in `~/.m2/settings.xml` (the home tmpfs is per-run).
- **Memory.** JVM heap defaults to 25% of container memory. Set `runner.resources.memory: 8Gi` for non-trivial builds.

## Worked example

[**spring-projects/spring-petclinic**](https://github.com/spring-projects/spring-petclinic) — Maven, single-module.

```yaml
# mergecrew.yaml
version: 1
runner:
  image: ghcr.io/mergecrew/runner-java:21
  resources: { cpu: 4, memory: 4Gi }
```

No `build.commands` override — defaults work. `mvn -B -q dependency:resolve` populates the local repo at `~/.m2/repository` (inside the per-run tmpfs), then `mvn -B -q test` runs the unit suite.

## Refs

- Image: `infra/images/runner-java/Dockerfile` (#567)
- Detection matrix: `packages/skills/src/stock/detect-stack.ts` (#566)
