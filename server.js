const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const cookieParser = require('cookie-parser');

const app = express();
const PORT = 3000;

// Middleware setup
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret-for-dev',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static('public'));

// Data file paths
const DATA_DIR = path.join(__dirname, 'data');
const CODES_PATH = path.join(DATA_DIR, 'codes.json');
const TEAMS_PATH = path.join(DATA_DIR, 'teams.json');

// Initialize data directory and files
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize empty files if they don't exist
[CODES_PATH, TEAMS_PATH].forEach(file => {
    if (!fs.existsSync(file)) {
        fs.writeFileSync(file, file === TEAMS_PATH ? '{}' : '[]');
    }
});

// Enhanced team data structure
const DEFAULT_TEAM = {
    password: '',
    points: 0,
    currentClue: null,
    attempts: {},
    disqualified: false
};

// Improved data loading middleware
app.use((req, res, next) => {
    try {
        // Read and parse files safely
        const codesData = fs.readFileSync(CODES_PATH, 'utf-8');
        const teamsData = fs.readFileSync(TEAMS_PATH, 'utf-8');
        
        req.codes = codesData ? JSON.parse(codesData) : [];
        req.teams = teamsData ? JSON.parse(teamsData) : {};
        
        next();
    } catch (err) {
        console.error('Error loading data:', err);
        // Initialize with empty data if there's an error
        req.codes = [];
        req.teams = {};
        next(err);
    }
});

// Save functions
function saveCodes(codes) {
    try {
        fs.writeFileSync(CODES_PATH, JSON.stringify(codes, null, 2));
        return true;
    } catch (err) {
        console.error('Error saving codes:', err);
        return false;
    }
}

function saveTeams(teams) {
    try {
        fs.writeFileSync(TEAMS_PATH, JSON.stringify(teams, null, 2));
        return true;
    } catch (err) {
        console.error('Error saving teams:', err);
        return false;
    }
}

// Auth middleware
function checkAuth(req, res, next) {
    if (req.session.team || req.path.includes('/login')) {
        return next();
    }
    res.redirect('/index.html?message=Session+expired.+Please+login+again.&messageType=error');
}

// Login route
app.post('/login', (req, res) => {
    const { teamName, password } = req.body;
    
    if (!teamName || !password) {
        return res.redirect('/index.html?message=Team+name+and+password+required&messageType=error');
    }

    if (!req.teams[teamName] || req.teams[teamName].password !== password) {
        return res.redirect('/index.html?message=Invalid+credentials.+Please+try+again.&messageType=error');
    }

    req.session.team = teamName;
    req.session.save(err => {
        if (err) {
            console.error('Session save error:', err);
            return res.redirect('/index.html?message=Login+failed&messageType=error');
        }

        if (teamName.toLowerCase() === 'admin') {
            return res.redirect('/admin.html');
        }

        if (req.teams[teamName].disqualified) {
            return res.redirect(`/dashboard.html?team=${encodeURIComponent(teamName)}&message=Your+team+has+been+disqualified.&messageType=error`);
        }

        // Initialize round2 data if it doesn't exist
        if (!req.teams[teamName].round2) {
            req.teams[teamName].round2 = {
                availableCodes: Array.from({length: 12}, (_, i) => `code${i+1}`),
                frozenCodes: [],
                attempts: {}
            };
            saveTeams(req.teams);
        }

        return res.redirect(`/rules_round2.html?team=${encodeURIComponent(teamName)}`);
    });
});

// Protected routes
app.get('/dashboard.html', checkAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public/dashboard.html'));
});

app.get('/admin.html', checkAuth, (req, res) => {
    if (req.session.team?.toLowerCase() !== 'admin') {
        return res.redirect('/index.html');
    }
    res.sendFile(path.join(__dirname, 'public/admin.html'));
});

// Rules page route
app.get('/rules_round2.html', checkAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public/rules_round2.html'));
});

// Round 2 code selection page
app.get('/round2.html', checkAuth, (req, res) => {
    const team = req.session.team;
    const teamData = req.teams[team];
    
    if (!teamData.round2) {
        teamData.round2 = {
            availableCodes: Array.from({length: 12}, (_, i) => `code${i+1}`),
            frozenCodes: [],
            attempts: {}
        };
        saveTeams(req.teams);
    }
    
    res.sendFile(path.join(__dirname, 'public/round2.html'));
});

// Handle code selection
app.post('/select-code', (req, res) => {
    const { team, code } = req.body;

    if (!team || !code) {
        return res.status(400).json({ 
            success: false,
            error: "Team name and code are required",
            redirect: `/round2.html?message=Team+name+and+code+required&messageType=error`
        });
    }

    if (!req.teams[team]) {
        return res.status(400).json({ 
            success: false,
            error: "Team not found",
            redirect: `/round2.html?team=${team}&message=Team+not+found&messageType=error`
        });
    }

    const teamData = req.teams[team];
    
    if (!teamData.round2) {
        teamData.round2 = {
            availableCodes: Array.from({length: 12}, (_, i) => `code${i+1}`),
            frozenCodes: [],
            attempts: {}
        };
    }

    if (!teamData.round2.availableCodes.includes(code)) {
        return res.status(400).json({ 
            success: false,
            error: "Code not available",
            redirect: `/round2.html?team=${team}&message=Code+not+available&messageType=error`
        });
    }

    req.session.selectedCode = code;
    req.session.save(err => {
        if (err) {
            console.error('Session save error:', err);
            return res.status(500).json({ 
                success: false,
                error: "Session error",
                redirect: `/round2.html?team=${team}&message=Session+error&messageType=error`
            });
        }

        res.json({ 
            success: true,
            redirect: `/dashboard.html?team=${team}&code=${code}`
        });
    });
});

// Submit code endpoint - Fixed the foundClue issue
app.post('/submit-code', (req, res) => {
    const { team, clueCode } = req.body;
    const teamData = req.teams[team];
    const selectedCode = req.session.selectedCode;

    // Validate team exists
    if (!teamData) {
        return res.status(400).json({ 
            error: "Invalid team",
            redirect: `/round2.html?team=${team}&message=Invalid+team&messageType=error`
        });
    }

    // Find the clue
    const clue = req.codes.find(c => c.code === clueCode);
    
    // Handle invalid clue
    if (!clue) {
        // For Round 2 teams
        if (teamData.round2 && selectedCode) {
            teamData.round2.attempts[selectedCode] = (teamData.round2.attempts[selectedCode] || 0) + 1;
            const attemptsRemaining = 3 - teamData.round2.attempts[selectedCode];
            
            let message = `Invalid code. `;
            if (attemptsRemaining === 2) {
                message += `2 attempts remaining for ${selectedCode}`;
            } else if (attemptsRemaining === 1) {
                message += `1 attempt remaining for ${selectedCode}`;
            } else if (attemptsRemaining === 0) {
                message += `Last attempt for ${selectedCode}`;
            }
            
            // Check if max attempts reached
            if (teamData.round2.attempts[selectedCode] >= 3) {
                teamData.round2.availableCodes = teamData.round2.availableCodes.filter(c => c !== selectedCode);
                teamData.round2.frozenCodes.push(selectedCode);
                saveTeams(req.teams);
                
                return res.json({
                    error: "Max attempts reached",
                    message: `Code ${selectedCode} is now locked!`,
                    redirect: `/round2.html?team=${team}&message=Code+${selectedCode}+locked&messageType=error`
                });
            }
            
            saveTeams(req.teams);
            return res.status(400).json({
                error: "Invalid clue",
                message: message,
                redirect: `/dashboard.html?team=${team}&code=${selectedCode}`
            });
        }
        return res.status(400).json({
            error: "Invalid clue",
            redirect: `/dashboard.html?team=${team}&message=Invalid+clue+code&messageType=error`
        });
    }

    // Check if team already completed this clue
    if (clue.completedBy?.includes(team)) {
        return res.status(400).json({
            error: "Already completed",
            redirect: teamData.round2 
                ? `/round2.html?team=${team}&message=You+already+completed+this+clue.&messageType=info`
                : `/dashboard.html?team=${team}&message=You+already+completed+this+clue.&messageType=info`
        });
    }

    // Check if clue is locked (completed by another team)
    if (clue.locked) {
        return res.status(400).json({
            error: "Clue locked",
            redirect: teamData.round2 
                ? `/round2.html?team=${team}&message=This+clue+has+been+completed+by+another+team.&messageType=info`
                : `/dashboard.html?team=${team}&message=This+clue+has+been+completed+by+another+team.&messageType=info`
        });
    }

    // Add team to clue's working teams if not already there
    if (!clue.teams?.includes(team)) {
        clue.teams = clue.teams || [];
        clue.teams.push(team);
    }

    // Reset attempts counter for the selected code
    if (teamData.round2 && selectedCode) {
        teamData.round2.attempts[selectedCode] = 0;
    } else {
        teamData.totalIncorrectAttempts = 0;
    }
    
    // Set current clue
    teamData.currentClue = clue.code;

    // Save changes
    if (!saveTeams(req.teams) || !saveCodes(req.codes)) {
        return res.status(500).json({
            error: "Save failed",
            redirect: teamData.round2 
                ? `/round2.html?team=${team}&message=System+error.+Please+try+again.&messageType=error`
                : `/dashboard.html?team=${team}&message=System+error.+Please+try+again.&messageType=error`
        });
    }

    // Success - redirect to map with clue location
    res.json({
        success: true,
        message: "Clue accepted! Find the location on the map.",
        redirect: `/map.html?lat=${clue.location.lat}&lng=${clue.location.lng}&team=${team}&code=${clue.code}`
    });
});
// Verify clue at location
app.post('/verify-clue', (req, res) => {
    const { team, clueCode, enteredCode } = req.body;
    
    console.log(`Verify attempt: Team=${team}, Clue=${clueCode}, Code=${enteredCode}`);

    // Validate team
    if (!team || !req.teams[team]) {
        console.error('Invalid team:', team);
        return res.status(400).json({ success: false, message: "Invalid team." });
    }

    // Find the clue
    const codeIndex = req.codes.findIndex(c => c.code === clueCode);
    if (codeIndex === -1) {
        console.error('Clue not found:', clueCode);
        return res.status(400).json({ success: false, message: "Invalid clue code." });
    }
    const codeData = req.codes[codeIndex];

    // Check verification code
    if (enteredCode !== codeData.verificationCode) {
        console.log('Incorrect verification code');
        return res.status(200).json({ 
            success: false, 
            message: "Incorrect code. Please try again." 
        });
    }

    // Initialize completedBy if doesn't exist
    if (!Array.isArray(codeData.completedBy)) {
        codeData.completedBy = [];
    }

    // Initialize teams if doesn't exist
    if (!Array.isArray(codeData.teams)) {
        codeData.teams = [];
    }

    // Only proceed if team hasn't completed this before
    if (!codeData.completedBy.includes(team)) {
        console.log(`Recording completion for team ${team}`);
        codeData.completedBy.push(team);

        // Add team to teams[] if not already there
        if (!codeData.teams.includes(team)) {
            codeData.teams.push(team);
        }

        // Award points if first completion
        if (codeData.completedBy.length === 1) {
            req.teams[team].points += 100;
            codeData.locked = true;
            console.log(`Awarded 100 points to ${team} for first completion`);
        }
        
        // Clear current clue now that it's completed
        req.teams[team].currentClue = null;
        
        // Save changes
        if (!saveTeams(req.teams) || !saveCodes(req.codes)) {
            console.error('Failed to save data');
            return res.status(500).json({ success: false, message: "Error saving progress" });
        }
        
        console.log('Updated clue:', codeData);
    }

    res.status(200).json({
        success: true,
        points: req.teams[team].points,
        message: codeData.completedBy.length === 1 
            ? "✅ Bomb defused! 100 points awarded!" 
            : "Clue verified!"
    });
});
app.get('/admin-data', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync('data.json'));
        res.json(data);
    } catch (error) {
        console.error('Error reading data.json:', error);
        res.status(500).json({ error: 'Failed to load data' });
    }
});

// Admin endpoints
app.get('/admin-teams', (req, res) => {
    res.json(req.teams);
});

app.get('/admin-clues', (req, res) => {
    res.json(req.codes);
});

app.get('/debug-clue/:code', (req, res) => {
    const codeData = req.codes.find(c => c.code === req.params.code);
    if (!codeData) {
        return res.status(404).send('Clue not found');
    }
    res.json({
        clue: codeData,
        teams: Object.keys(req.teams).filter(team => 
            req.teams[team].currentClue === req.params.code
        )
    });
});

// Team management
app.post('/create-team', (req, res) => {
    const { name, password } = req.body;
    
    if (!name || !password) {
        return res.status(400).send("Team name and password are required.");
    }
    
    if (req.teams[name]) {
        return res.status(400).send("Team already exists.");
    }
    
    req.teams[name] = { ...DEFAULT_TEAM, password };
    if (!saveTeams(req.teams)) {
        return res.status(500).send("Error creating team.");
    }
    res.send("Team created successfully.");
});

app.post('/reset-team', (req, res) => {
    const { team } = req.body;
    
    if (!team || !req.teams[team]) {
        return res.status(400).send("Invalid team.");
    }
    
    // Clean up all clue references
    req.codes.forEach(clue => {
        // Reset teams array if it only contained this team
        if (clue.teams && clue.teams.includes(team)) {
            clue.teams = clue.teams.filter(t => t !== team);
            if (clue.teams.length === 0) {
                clue.teams = []; // Ensure empty array
            }
        }
        
        // Clean completedBy
        if (clue.completedBy && clue.completedBy.includes(team)) {
            clue.completedBy = clue.completedBy.filter(t => t !== team);
            if (clue.completedBy.length === 0) {
                clue.locked = false;
            }
        }
    });
    
    // Reset team data
    req.teams[team] = { 
        ...DEFAULT_TEAM,
        password: req.teams[team].password 
    };
    
    if (!saveTeams(req.teams) || !saveCodes(req.codes)) {
        return res.status(500).send("Error saving data");
    }
    
    res.send("Team reset successfully. Clue counts updated.");
});

app.post('/reset-all', (req, res) => {
    // Reset all teams
    for (const team in req.teams) {
        req.teams[team] = { ...DEFAULT_TEAM, password: req.teams[team].password };
    }
    if (!saveTeams(req.teams)) {
        return res.status(500).send("Error resetting teams.");
    }
    
    // Reset all clues
    req.codes.forEach(clue => {
        clue.completedBy = [];
        clue.locked = false;
    });
    if (!saveCodes(req.codes)) {
        return res.status(500).send("Error resetting clues.");
    }
    
    res.send("All teams and clues reset successfully.");
});

app.post('/reset-points', (req, res) => {
    // Reset points for all teams
    for (const team in req.teams) {
        req.teams[team].points = 0;
    }
    if (!saveTeams(req.teams)) {
        return res.status(500).send("Error resetting points.");
    }
    
    res.send("All points reset successfully.");
});
// Add this endpoint to your server.js (before app.listen)
app.get('/team-data', checkAuth, (req, res) => {
    const teamName = req.session.team;
    
    if (!teamName || !req.teams[teamName]) {
        return res.status(404).json({ error: "Team not found" });
    }

    // Initialize round2 data if it doesn't exist
    if (!req.teams[teamName].round2) {
        req.teams[teamName].round2 = {
            availableCodes: Array.from({length: 12}, (_, i) => `code${i+1}`),
            frozenCodes: [],
            attempts: {}
        };
        saveTeams(req.teams);
    }

    res.json({
        team: teamName,
        round2: req.teams[teamName].round2
    });
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    // Ensure data directory exists
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR);
    }
});