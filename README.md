
# Backend Setup

## Install
npm install

## Add API Key and Database Config
Create a `.env` file from `.env.example` and fill in your values.

Required values:
- `GEMINI_API_KEY`
- `DATABASE_URL` or `PGHOST`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`

Optional values:
- `GEMINI_MODEL` (defaults to `gemini-2.5-flash`)
- `PGSSLMODE` (set to `require` if needed)
- `DEBUG=false`

## Run
npm start
