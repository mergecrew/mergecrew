# Per-run workspace image for Java stacks (#567).
# Ships Temurin 21 + Maven + Gradle so both major build systems work
# out of the box. See docs/03-infrastructure/22-runner-images.md.

ARG JDK_TAG=21-jdk-jammy
FROM eclipse-temurin:${JDK_TAG}

ARG MISE_VERSION=v2025.5.0
ARG MAVEN_VERSION=3.9.9
ARG GRADLE_VERSION=8.10.2

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        git \
        tini \
        unzip \
    && rm -rf /var/lib/apt/lists/*

# Maven (multi-arch via the Apache tarball).
RUN curl -fsSL "https://archive.apache.org/dist/maven/maven-3/${MAVEN_VERSION}/binaries/apache-maven-${MAVEN_VERSION}-bin.tar.gz" \
    | tar -xz -C /opt \
    && ln -s "/opt/apache-maven-${MAVEN_VERSION}/bin/mvn" /usr/local/bin/mvn \
    && mvn --version

# Gradle (multi-arch via the official distribution zip).
RUN curl -fsSL "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" -o /tmp/gradle.zip \
    && unzip -q /tmp/gradle.zip -d /opt \
    && ln -s "/opt/gradle-${GRADLE_VERSION}/bin/gradle" /usr/local/bin/gradle \
    && rm /tmp/gradle.zip \
    && gradle --version

# mise
ENV MISE_VERSION=${MISE_VERSION}
RUN curl -fsSL https://mise.run | MISE_VERSION="${MISE_VERSION}" sh \
    && mv /root/.local/bin/mise /usr/local/bin/mise \
    && chmod +x /usr/local/bin/mise \
    && mise --version

RUN groupadd --system --gid 1001 mergecrew \
    && useradd --system --uid 1001 --gid 1001 \
        --no-create-home --home-dir /home/mergecrew \
        --shell /bin/bash mergecrew

RUN mkdir -p /workspace \
    && chown 1001:1001 /workspace \
    && chmod 0775 /workspace

USER mergecrew
WORKDIR /workspace

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bash"]
