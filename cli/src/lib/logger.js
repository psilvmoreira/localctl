const chalk = require('chalk');

module.exports = {
  info: (msg) => console.log(chalk.cyan('info'), msg),
  warn: (msg) => console.log(chalk.yellow('warn'), msg),
  error: (msg) => console.error(chalk.red('error'), msg),
  success: (msg) => console.log(chalk.green('ok'), msg),
  step: (msg) => console.log(chalk.magenta('>'), msg),
};
