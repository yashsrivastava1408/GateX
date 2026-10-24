# GateX documentation

GateX checks your work against a scorecard. Three AI Examiners mark your file on their own, a Final reviewer compares their marks, and a fixed
rule decides green, amber or red.

| I want to... | Read |
|---|---|
| **Get my file checked and read the report** | [user-guide.md](user-guide.md) |
| **See what GateX does at each step, and where its code is** | [agent.md](agent.md) |
| See how the whole system fits together | [architecture.md](architecture.md) |
| Write or review a scorecard | [scorecard-reference.md](scorecard-reference.md) |
| Install, set up, run and back up GateX | [operations.md](operations.md) |
| Call GateX from a script | [api.md](api.md) |
| See how files and keys are protected | [security.md](security.md) |
| See how GateX follows the Agentic Roadmap PDF, page by page | [pdf-traceability.md](pdf-traceability.md) |
| Understand why it was built this way | [decisions.md](decisions.md) |
| Change the code | [development.md](development.md) |

## Reading order

- **Author adding a file:** [user-guide.md](user-guide.md), then [scorecard-reference.md](scorecard-reference.md), then your report.
- **Mentor or lead:** [agent.md](agent.md), then [pdf-traceability.md](pdf-traceability.md), then [security.md](security.md).
- **Engineer taking it over:** [architecture.md](architecture.md), then [agent.md](agent.md), [development.md](development.md) and [decisions.md](decisions.md).
- **Whoever runs it:** [operations.md](operations.md), then [security.md](security.md).

## Diagrams

The sources are in [`diagrams/`](diagrams/) (Mermaid) and the pictures are in [`images/`](images/).

| Diagram | Used in |
|---|---|
| `00-architecture` (live Mermaid, drawn by GitHub) | the main README, architecture.md |
| `images/architecture.svg` (the same view as a drawn picture) | linked from both for viewers that do not draw Mermaid |
| `01-system-context` | architecture.md |
| `02-agent-pipeline` | agent.md |
| `03-evaluation-sequence` | architecture.md |
| `04-data-model` | architecture.md |
| `05-verdict-rule` | agent.md |
| `06-iteration-loop` | architecture.md |
| `07-trust-boundaries` | security.md |
| `08-deployment` | architecture.md |

After editing a source, redraw the pictures with `bash docs/diagrams/render.sh`.
