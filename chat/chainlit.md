# Albert Chat

Talk to the Albert harness. This chat is backed by a read-only concierge with live access to
the run store.

- **Ask about runs**: "what is the active run doing?", "which tasks are left?", "how much
  budget is spent?"
- **Steer a running orchestrator**: "tell Albert to prioritize the CSV export task". Messages
  queue in the run's inbox; A.L.B.E.R.T. reads them at the start of its next wake and replies
  here, so answers from the orchestrator itself can take minutes.
- **Start a new run**: "start a run in `<project>`: `<goal>`". The run opens in its own
  console window and registers with the harness.

The Albert Console at [http://127.0.0.1:4400](http://127.0.0.1:4400) shows the same chat
traffic in its Comms feed.
