"""HTTP client for the Mergecrew API.

Mirrors the canonical surface of `@mergecrew/sdk` (TypeScript) at the
verb level: every endpoint in `docs/openapi.json` is reachable via
`mc.request("GET", "/v1/orgs/{slug}/projects", path={"slug": "demo"})`,
with thin convenience wrappers around the most common operations.

This deliberately stays a thin layer on top of httpx — Python integrators
who want fully-typed Pydantic models can run `openapi-python-client` over
`docs/openapi.json` themselves; we won't commit ~150 generated files into
this repo just for that.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping, Optional

import httpx

DEFAULT_BASE_URL = "https://api.mergecrew.dev"


class MergecrewError(RuntimeError):
    """Raised when the API returns a non-2xx response."""

    def __init__(self, status_code: int, body: Any):
        super().__init__(f"Mergecrew API error {status_code}: {body!r}")
        self.status_code = status_code
        self.body = body


class Mergecrew:
    """Synchronous Mergecrew API client.

    Example:
        >>> mc = Mergecrew(api_key=os.environ["MERGECREW_API_KEY"])
        >>> projects = mc.list_projects("demo")
        >>> mc.create_run("demo", "acme")
    """

    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 30.0,
        transport: Optional[httpx.BaseTransport] = None,
    ) -> None:
        if not api_key:
            raise ValueError("api_key is required")
        self._client = httpx.Client(
            base_url=base_url.rstrip("/"),
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=timeout,
            transport=transport,
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "Mergecrew":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    # -------------------------------------------------------------- low level

    def request(
        self,
        method: str,
        path: str,
        *,
        path_params: Optional[Mapping[str, str]] = None,
        params: Optional[Mapping[str, Any]] = None,
        json: Any = None,
    ) -> Any:
        """Generic typed-string-template request.

        `path` may contain `{slug}`-style placeholders that get filled from
        `path_params`. Returns the parsed JSON body on success; raises
        `MergecrewError` on non-2xx.
        """
        url = path.format(**(path_params or {}))
        resp = self._client.request(method, url, params=params, json=json)
        if resp.status_code >= 400:
            try:
                body: Any = resp.json()
            except Exception:
                body = resp.text
            raise MergecrewError(resp.status_code, body)
        if resp.status_code == 204 or not resp.content:
            return None
        return resp.json()

    # --------------------------------------------------------- convenience API

    def list_orgs(self) -> Iterable[Mapping[str, Any]]:
        return self.request("GET", "/v1/orgs").get("items", [])

    def list_projects(self, org_slug: str) -> Iterable[Mapping[str, Any]]:
        return self.request(
            "GET",
            "/v1/orgs/{slug}/projects",
            path_params={"slug": org_slug},
        ).get("items", [])

    def create_run(self, org_slug: str, project_slug: str) -> Mapping[str, Any]:
        return self.request(
            "POST",
            "/v1/orgs/{slug}/projects/{projectSlug}/runs",
            path_params={"slug": org_slug, "projectSlug": project_slug},
        )

    def list_runs(
        self, org_slug: str, project_slug: str, *, limit: int = 50
    ) -> Iterable[Mapping[str, Any]]:
        return self.request(
            "GET",
            "/v1/orgs/{slug}/projects/{projectSlug}/runs",
            path_params={"slug": org_slug, "projectSlug": project_slug},
            params={"limit": limit},
        ).get("items", [])

    def get_run(
        self, org_slug: str, project_slug: str, run_id: str
    ) -> Mapping[str, Any]:
        return self.request(
            "GET",
            "/v1/orgs/{slug}/projects/{projectSlug}/runs/{runId}",
            path_params={
                "slug": org_slug,
                "projectSlug": project_slug,
                "runId": run_id,
            },
        )

    def get_timeline(
        self, org_slug: str, project_slug: str, run_id: str
    ) -> Iterable[Mapping[str, Any]]:
        return self.request(
            "GET",
            "/v1/orgs/{slug}/projects/{projectSlug}/runs/{runId}/timeline",
            path_params={
                "slug": org_slug,
                "projectSlug": project_slug,
                "runId": run_id,
            },
        ).get("items", [])
