from flask import Flask, jsonify

app = Flask(__name__)

USERS = {
    1: {"id": 1, "name": "Ada"},
    2: {"id": 2, "name": "Hopper"},
}


@app.get("/healthz")
def healthz():
    return jsonify(ok=True)


# TODO: add GET /users/<int:id> — tests/test_app.py exercises it.


if __name__ == "__main__":
    app.run()
