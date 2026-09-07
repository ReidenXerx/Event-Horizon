//! `eh` — the headless surface.
//!
//! Stage 1 is `eh verify <package.ehcoll>`: read a package, check every
//! archive against its recorded SHA-256, report `matches` / `differs` /
//! `damaged` / `unknown`. No install, no deployment, no game touched. It is
//! useful on its own — a curator can run it in CI against their own package —
//! and it proves the core is genuinely free of any host mod manager.
//!
//! NS-4: this binary is an adapter. Argument parsing and output formatting
//! live here; nothing else does.
//!
//! STATUS: skeleton. `verify` is not implemented and says so.

fn main() -> std::process::ExitCode {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("verify") => {
            eprintln!("eh verify: not implemented yet (Stage 1 skeleton).");
            std::process::ExitCode::from(70)
        }
        Some(other) => {
            eprintln!("eh: unknown subcommand {other:?}. Try `eh verify <package.ehcoll>`.");
            std::process::ExitCode::FAILURE
        }
        None => {
            eprintln!("eh <subcommand>\n\n  verify <package.ehcoll>   check archives against recorded hashes");
            std::process::ExitCode::FAILURE
        }
    }
}
