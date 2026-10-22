//! The command line, read by hand: three flags don't need a parser.

use std::fmt;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub const HELP: &str = "\
pathofdev: the Path of Dev game in a terminal pane beside Claude Code

Usage:
  pathofdev watch                 watch the local server, the one Claude Code plays on
  pathofdev watch --server dev    watch the dev sandbox (PATHOFDEV_DEV=1) instead
  pathofdev --version             print the version
  pathofdev --help                print this

In the app: 1-4 or the arrows switch tabs, ? shows the keys, q quits.
PATHOFDEV_HOME names the home the local server uses, as it does for the server.";

/// What the command line asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Help,
    Version,
    Watch { dev: bool },
}

/// A command line that asks for nothing this build does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Usage(pub String);

impl fmt::Display for Usage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}\n\n{HELP}", self.0)
    }
}

/// The command `args` (without the program's name) ask for.
pub fn parse<S: AsRef<str>>(args: &[S]) -> Result<Command, Usage> {
    let args: Vec<&str> = args.iter().map(AsRef::as_ref).collect();
    match args.as_slice() {
        [] | ["--help" | "-h" | "help", ..] => Ok(Command::Help),
        ["--version" | "-V"] => Ok(Command::Version),
        ["watch", rest @ ..] => watch(rest),
        [other, ..] => Err(Usage(format!("pathofdev doesn't know {other:?}."))),
    }
}

fn watch(rest: &[&str]) -> Result<Command, Usage> {
    let mut dev = false;
    let mut flags = rest.iter();
    while let Some(flag) = flags.next() {
        let server = match *flag {
            "--help" | "-h" => return Ok(Command::Help),
            "--server" => flags.next().copied(),
            other => match other.strip_prefix("--server=") {
                Some(server) => Some(server),
                None => return Err(Usage(format!("pathofdev watch doesn't know {other:?}."))),
            },
        };
        dev = match server {
            Some("local") => false,
            Some("dev") => true,
            Some("online") => {
                return Err(Usage("Watching the online server comes in a later version: this one watches a local server.".into()));
            }
            Some(other) => return Err(Usage(format!("--server is local or dev, not {other:?}."))),
            None => return Err(Usage("--server needs local or dev after it.".into())),
        };
    }
    Ok(Command::Watch { dev })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_commands() {
        assert_eq!(parse::<&str>(&[]), Ok(Command::Help));
        assert_eq!(parse(&["--version"]), Ok(Command::Version));
        assert_eq!(parse(&["watch"]), Ok(Command::Watch { dev: false }));
        assert_eq!(
            parse(&["watch", "--server", "dev"]),
            Ok(Command::Watch { dev: true })
        );
        assert_eq!(
            parse(&["watch", "--server=local"]),
            Ok(Command::Watch { dev: false })
        );
        assert_eq!(parse(&["watch", "--help"]), Ok(Command::Help));
    }

    #[test]
    fn refuses_what_it_doesnt_know() {
        assert!(parse(&["play"]).is_err());
        assert!(parse(&["watch", "--server"]).is_err());
        assert!(parse(&["watch", "--server", "online"]).is_err());
        assert!(parse(&["watch", "--loud"]).is_err());
        assert!(parse(&["--version", "extra"]).is_err());
    }
}
