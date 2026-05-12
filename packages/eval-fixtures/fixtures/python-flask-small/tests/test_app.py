from app import app


def test_get_user_existing():
    client = app.test_client()
    r = client.get("/users/1")
    assert r.status_code == 200
    assert r.get_json() == {"id": 1, "name": "Ada"}


def test_get_user_missing():
    client = app.test_client()
    r = client.get("/users/999")
    assert r.status_code == 404
