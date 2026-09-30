# My Day — daily to-do app

A to-do list with a daily progress bar, top 3 tasks, quick notes, reminders (morning, afternoon, night),
a nightly review with a streak, a weekly summary, and a reminder of what you said you'd do better at.

## Starting and stopping

| File | Double-click it to… |
|------|---------------------|
| `start.bat` | Start the app in the background and open it in your browser |
| `stop.bat` | Stop the app |
| `autostart-on.bat` | Make the app start by itself when you log in to Windows |
| `autostart-off.bat` | Turn auto-start off again |

The app's address is http://localhost:8000. Reminders only pop up while that page is open in a browser tab.

## Putting it online

See **DEPLOY.md** for step-by-step instructions (Render + Supabase). Online, the app stores its data in
PostgreSQL instead of `todo.db`. There is no password: anyone with the web address can open it.

## Features

- **To-do list:** add, tick off, edit (double-click), reorder (drag ⋮⋮ or ↑ ↓), delete
- **Top 3:** star (☆) up to 3 tasks a day that matter most
- **Progress bar:** tasks done today, plus top-3 progress
- **Quick notes:** Ctrl + Enter to save
- **Reminders:** morning (plan and pick your top 3), afternoon (check progress), night (review)
- **Night review:** what went well, what didn't, what to do better tomorrow, one thing you're grateful for
- **Streak 🔥:** days in a row with a night review
- **Weekly summary 📊:** completion per day and your "do better" answers for the week
- **Backup & export (⚙️ Settings):** back up now, download the database, export CSV for Excel.
  An automatic backup is also made each day in `backups/` (the last 14 are kept).

## What's in here

| File | What it does |
|------|--------------|
| `backend/main.py` | The Python (FastAPI) server. It saves everything to the database. |
| `frontend/app.jsx` | The React app (everything you see and click). |
| `frontend/styles.css` | Colors and layout. |
| `frontend/index.html` | The page that loads React and the app. |
| `start-hidden.vbs` | Starts the server without a black window (used by `start.bat` and auto-start). |
| `todo.db` | Your SQLite database with all tasks, notes, and reviews. |
| `backups/` | Automatic and manual copies of the database. |
| `libs/` | Installed Python packages (FastAPI, uvicorn). |

## Database tables

- `todos`: your tasks, per day (text, done, order, priority)
- `notes`: quick notes, per day
- `reviews`: nightly review answers, per day
- `reminders_seen`: which reminders were already shown each day
- `settings`: your reminder times
