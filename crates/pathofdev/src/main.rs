use std::process::ExitCode;

use pathofdev::cli::{self, Command, HELP, VERSION};
use pathofdev::watch::{self, Ended};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match cli::parse(&args) {
        Ok(Command::Help) => {
            println!("{HELP}");
            ExitCode::SUCCESS
        }
        Ok(Command::Version) => {
            println!("pathofdev {VERSION}");
            ExitCode::SUCCESS
        }
        Ok(Command::Watch { dev }) => match watch::watch(dev) {
            Ok(Ended::Quit) => ExitCode::SUCCESS,
            Ok(Ended::AlreadyWatching) => {
                println!("Already watching in another pane.");
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("pathofdev: {error}");
                ExitCode::FAILURE
            }
        },
        Err(usage) => {
            eprintln!("{usage}");
            ExitCode::from(2)
        }
    }
}
