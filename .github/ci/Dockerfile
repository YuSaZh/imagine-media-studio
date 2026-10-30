# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE
ARG BROWSER_IMAGE
ARG DOCKER_IMAGE
FROM ${NODE_IMAGE} AS node
FROM ${DOCKER_IMAGE} AS docker
FROM ${BROWSER_IMAGE}

ARG PNPM_VERSION
ARG NOTO_CORE_VERSION
ARG NOTO_CJK_VERSION
COPY --from=node /usr/local/ /usr/local/
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/

ENV COREPACK_HOME=/opt/imagine-corepack
RUN apt-get update \
  && apt-get install --yes --no-install-recommends git ffmpeg build-essential python3 \
    "fonts-noto-core=${NOTO_CORE_VERSION}" "fonts-noto-cjk=${NOTO_CJK_VERSION}" \
  && rm -rf /var/lib/apt/lists/* \
  && rm -f /usr/local/bin/yarn /usr/local/bin/yarnpkg \
  && corepack enable pnpm \
  && corepack prepare "pnpm@${PNPM_VERSION}" --activate \
  && chmod -R a+rX /opt/imagine-corepack \
  && node --version && pnpm --version && docker compose version && docker buildx version \
  && fc-cache -f

ARG CI_FINGERPRINT
LABEL org.imagine.ci.fingerprint="${CI_FINGERPRINT}"
RUN printf '%s\n' "${CI_FINGERPRINT}" > /etc/imagine-ci-toolchain
