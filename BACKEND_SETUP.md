# Running the Newspaper App with Backend

## Setup Complete! ✅

Your newspaper app now has a fully functional backend that persists data to the JSON file.

## How to Run

### Option 1: Run Everything Together (Recommended)
```bash
npm run dev
```
This starts both the backend server (port 3000) and Angular dev server (port 4200) simultaneously.

### Option 2: Run Separately
**Terminal 1 - Backend:**
```bash
npm run server
```

**Terminal 2 - Angular:**
```bash
npm start
```

## Access the Application

- **Viewer**: http://localhost:4200
- **Admin Panel**: http://localhost:4200/admin
- **Backend API**: http://localhost:3000/api/newspaper-data

## How It Works

### Backend Server (server.js)
- **GET /api/newspaper-data**: Reads and returns data from `src/assets/newspaper-data.json`
- **POST /api/newspaper-data**: Saves data to `src/assets/newspaper-data.json`

### Data Flow
1. Admin panel loads data from backend API
2. You make changes (add pages, sections, use crop selector)
3. Click "Save All" to persist changes to the JSON file
4. Changes are immediately available in the viewer
5. Data persists even after browser refresh! 🎉

## Features Now Working

✅ **Persistent Data** - Changes save to the actual JSON file
✅ **Auto-reload** - Viewer reflects admin changes immediately
✅ **Session Persistence** - Navigate between viewer/admin without losing data
✅ **Real CRUD** - Create, Read, Update, Delete operations work fully
✅ **Visual Crop Selector** - Coordinates save properly
✅ **Download JSON** - Backup functionality still available

## Important Notes

⚠️ **Node.js Version**: This app requires Node.js v18.19+ for Angular 18. You're currently on v16.18.0.

To upgrade Node.js:
```bash
# Using nvm (recommended)
nvm install 18
nvm use 18

# Or download from nodejs.org
```

## Development Workflow

1. Start the app with `npm run dev`
2. Open admin panel at http://localhost:4200/admin
3. Add/edit pages and sections
4. Use Visual Crop Selector for precise coordinates
5. Click "Save All" - data writes to JSON file
6. Check viewer at http://localhost:4200 - changes are live!
7. No need to download JSON anymore - it auto-saves! ✨

## Production Deployment

For production, you'll want to:
1. Build Angular app: `npm run build`
2. Serve built files from Express
3. Use proper database instead of JSON file
4. Add authentication/authorization
5. Set up environment variables

## Troubleshooting

**"Failed to read data" error:**
- Make sure backend server is running (`npm run server`)
- Check that `src/assets/newspaper-data.json` exists

**CORS errors:**
- Backend includes CORS middleware for development
- In production, configure CORS for your domain

**Port already in use:**
- Backend uses port 3000
- Angular uses port 4200
- Change ports in `server.js` or `angular.json` if needed

## Architecture

```
┌─────────────────────────────────────────┐
│         Browser (localhost:4200)         │
│  ┌──────────────┐    ┌───────────────┐  │
│  │    Viewer    │    │  Admin Panel  │  │
│  └──────┬───────┘    └───────┬───────┘  │
│         │                    │          │
│         └────────┬───────────┘          │
└──────────────────┼──────────────────────┘
                   │ HTTP Requests
                   │
┌──────────────────▼──────────────────────┐
│    Express Server (localhost:3000)      │
│  ┌────────────────────────────────────┐ │
│  │  GET  /api/newspaper-data          │ │
│  │  POST /api/newspaper-data          │ │
│  └────────────────┬───────────────────┘ │
└─────────────────────┼───────────────────┘
                      │ File I/O
                      │
┌─────────────────────▼───────────────────┐
│     src/assets/newspaper-data.json       │
│          (Persistent Storage)            │
└──────────────────────────────────────────┘
```

## Next Steps

- ✨ Changes now persist automatically
- 🎨 Customize the admin panel styling
- 🔐 Add authentication for admin access
- 📊 Add more features (bulk operations, templates, etc.)
- 🚀 Deploy to production with proper database

Enjoy your fully functional newspaper app! 🎉
