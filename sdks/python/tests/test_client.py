import httpx
import pytest

from mergecrew import Mergecrew, MergecrewError


def _transport(handler):
    return httpx.MockTransport(handler)


def test_attaches_bearer_header_and_base_url():
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["auth"] = request.headers.get("authorization")
        return httpx.Response(200, json={"items": []})

    mc = Mergecrew(
        api_key="mc_live_test-secret",
        base_url="http://localhost:4000",
        transport=_transport(handler),
    )
    assert list(mc.list_projects("demo")) == []
    assert captured["url"] == "http://localhost:4000/v1/orgs/demo/projects"
    assert captured["auth"] == "Bearer mc_live_test-secret"


def test_path_templating_fills_placeholders():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(201, json={"id": "run-123", "status": "queued"})

    mc = Mergecrew(
        api_key="mc_live_x",
        base_url="http://api.test",
        transport=_transport(handler),
    )
    out = mc.create_run("demo", "acme")
    assert seen == ["http://api.test/v1/orgs/demo/projects/acme/runs"]
    assert out["id"] == "run-123"


def test_raises_on_non_2xx_with_parsed_body():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": {"code": "UNAUTHORIZED"}})

    mc = Mergecrew(
        api_key="mc_live_bad",
        base_url="http://api.test",
        transport=_transport(handler),
    )
    with pytest.raises(MergecrewError) as ei:
        mc.list_orgs()
    assert ei.value.status_code == 401
    assert ei.value.body == {"error": {"code": "UNAUTHORIZED"}}


def test_204_returns_none():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(204)

    mc = Mergecrew(
        api_key="mc_live_x",
        base_url="http://api.test",
        transport=_transport(handler),
    )
    # Reach the low-level request directly since no convenience method
    # currently surfaces a 204.
    assert mc.request("DELETE", "/v1/orgs/{slug}/api-keys/{id}", path_params={"slug": "demo", "id": "k1"}) is None


def test_default_base_url_is_production():
    mc = Mergecrew(api_key="mc_live_x")
    assert str(mc._client.base_url) == "https://api.mergecrew.dev"
    mc.close()


def test_empty_api_key_rejected():
    with pytest.raises(ValueError):
        Mergecrew(api_key="")
