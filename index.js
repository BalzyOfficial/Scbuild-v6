const { spawn } = require('child_process');
const path = require('path');

let p;
let isRestarting = false;

function start() {
    const scriptPath = path.join(__dirname, 'rappbuild.js');
    let args = [scriptPath, ...process.argv.slice(2)];

    console.log('([ SYSTEM ]) Memulai BotBuild Manager...');

    p = spawn(process.argv[0], args, {
        stdio: ['inherit', 'inherit', 'inherit', 'ipc']
    });

    p.on('message', data => {
        if (data === 'reset') {
            console.log('Restarting requested...');
            restartBot();
        }
    });

    p.on('exit', code => {
        if (!isRestarting) {
            console.error('([ SYSTEM ]) Bot crash. Restarting dalam 3 detik...', code);
            setTimeout(start, 3000);
        }
    });
}

function restartBot() {
    if (isRestarting) return;
    isRestarting = true;
    
    console.log('([ SYSTEM ]) Restarting bot...');
    
    if (p) {
        p.kill('SIGTERM');
    }
    
    setTimeout(() => {
        isRestarting = false;
        start();
    }, 2000);
}

// Start bot
start();

// Handle SIGINT
process.on('SIGINT', () => {
    console.log('\n([ SYSTEM ]) Shutting down...');
    if (p) p.kill('SIGTERM');
    process.exit(0);
});