# Stack cookbook: Python

Default workspace image: [`ghcr.io/mergecrew/runner-python:3.12`](22-runner-images.md).

## Detection signals

The runner picks the Python stack when any of these exist in the workspace root: `pyproject.toml`, `requirements.txt`. Package manager is inferred from the lockfile:

| File | Package manager |
| --- | --- |
| `poetry.lock` | `poetry` |
| `uv.lock` | `uv` |
| anything else | `pip` |

## Default build commands

### Poetry

| Skill | Command |
| --- | --- |
| install | `poetry install --no-interaction` |
| typecheck | `poetry run mypy .` |
| lint | `poetry run ruff check .` |
| test | `poetry run pytest` |

### uv

| Skill | Command |
| --- | --- |
| install | `uv sync` |
| typecheck | `uv run mypy .` |
| lint | `uv run ruff check .` |
| test | `uv run pytest` |

### pip / requirements.txt

| Skill | Command |
| --- | --- |
| install | `pip install -r requirements.txt` |
| typecheck | `mypy .` |
| lint | `ruff check .` |
| test | `pytest` |

`build.run_integration_tests` is `null` by default for Python — there's no universal convention. Override per-project if you have an integration suite.

## Common overrides

```yaml
# mergecrew.yaml
build:
  commands:
    # Project uses nox to orchestrate test matrices
    test: { cmd: "nox", args: ["-s", "tests"] }
    # Strict mypy on a specific package
    typecheck: { cmd: "poetry", args: ["run", "mypy", "--strict", "src/myapp"] }
    # Run black --check as a lint step in addition to ruff
    lint: { cmd: "sh", args: ["-c", "ruff check . && black --check ."] }
```

Pin a specific Python version via `.tool-versions`:

```
# .tool-versions
python 3.11.7
```

## Worked example

[**tiangolo/fastapi**](https://github.com/tiangolo/fastapi) — `pyproject.toml` + Poetry.

```yaml
# mergecrew.yaml
version: 1
runner:
  image: ghcr.io/mergecrew/runner-python:3.12
build:
  commands:
    test:      { cmd: "bash", args: ["scripts/test.sh"] }
    typecheck: { cmd: "poetry", args: ["run", "mypy", "fastapi"] }
    lint:      { cmd: "bash", args: ["scripts/lint.sh"] }
```

FastAPI ships shell scripts that orchestrate pytest + coverage + mypy. The override calls those rather than running pytest directly. `poetry.lock` triggers poetry detection so `install` uses `poetry install` cleanly.

## Refs

- Image: `infra/images/runner-python/Dockerfile` (#567)
- Detection matrix: `packages/skills/src/stock/detect-stack.ts` (#566)
