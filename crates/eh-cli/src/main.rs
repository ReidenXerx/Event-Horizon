//! `eh` - the headless surface.
//!
//! Stage 1 is `eh verify <package.ehcoll>`: read a package, check every
//! archive against its recorded SHA-256, report matches / differs / damaged /
//! unknown. No install, no deployment, no game touched.
//!
//! NS-4: this binary is an ADAPTER. Argument parsing, and choosing how
//! progress is drawn, live here. Nothing else does.

mod render;

use eh_progress::Unit;
use std::path::Path;
use std::process::ExitCode;

/// Extract one archive, reporting through whichever renderer fits the
/// environment. All logic lives in the engine; this formats the outcome.
fn unpack(archive: &Path, dest: &Path) -> ExitCode {
    let progress = render::for_environment();
    let task = progress.task(
        archive.file_name().unwrap_or_default().to_string_lossy(),
        None,
        Unit::Files,
    );
    match eh_engine::unpack(archive, dest, &task) {
        Ok(result) => {
            task.done();
            println!(
                "{} files, {} directories, {} bytes via {}",
                result.files,
                result.directories,
                result.bytes,
                result.via.as_str()
            );
            // Refusals are not fatal, but they are never silent.
            for refusal in &result.refused {
                eprintln!("refused {:?}: {}", refusal.raw, refusal.why.as_str());
            }
            for collision in &result.case_collisions {
                eprintln!(
                    "case collision: {:?} and {:?} are one file on Windows",
                    collision.first, collision.second
                );
            }
            if result.refused.is_empty() {
                ExitCode::SUCCESS
            } else {
                // Something in the archive tried to write outside the target.
                ExitCode::from(3)
            }
        }
        Err(e) => {
            task.failed(e.to_string());
            eprintln!("eh unpack: {e}");
            ExitCode::from(70)
        }
    }
}

fn usage() {
    eprintln!(
        "eh <subcommand>\n\n\
           verify <package.ehcoll>   check archives against recorded hashes\n\
           unpack <archive> <dest>   extract a zip/7z archive\n\
           demo-progress             exercise the loader (development aid)\n"
    );
}

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("verify") => {
            eprintln!("eh verify: not implemented yet (Stage 1 skeleton).");
            ExitCode::from(70)
        }
        Some("unpack") => {
            let (Some(archive), Some(dest)) = (args.next(), args.next()) else {
                eprintln!("eh unpack <archive> <dest>");
                return ExitCode::from(2);
            };
            unpack(Path::new(&archive), Path::new(&dest))
        }
        Some("demo-progress") => {
            demo_progress();
            ExitCode::SUCCESS
        }
        // Must precede the catch-all, or `--help` is an "unknown subcommand".
        Some("--help") | Some("-h") => {
            usage();
            ExitCode::SUCCESS
        }
        None => {
            usage();
            // Distinct from --help: nothing was asked for, so this is misuse.
            ExitCode::from(2)
        }
        Some(other) => {
            eprintln!("eh: unknown subcommand {other:?}. Try `eh --help`.");
            ExitCode::FAILURE
        }
    }
}

/// Drive the loader through the shapes real work will have, so it can be
/// judged before there is real work: a determinate byte download, a total
/// learned late, a skip, and a failure.
///
/// This is a development aid and says so in `--help`. It performs no I/O
/// beyond sleeping.
fn demo_progress() {
    use std::thread::sleep;
    use std::time::Duration;

    let progress = render::for_environment();
    // Four children, so the total is four. A parent whose total does not match
    // the work under it reaches 100% while work is still running - the same
    // lie an item-counted bar tells on a real collection.
    let run = progress.task("install demo-collection", Some(4), Unit::Mods);

    for (name, bytes) in [("Ivy.7z", 40_u64), ("RandomOverlay.rar", 25)] {
        let mod_task = run.child(name, Some(2), Unit::Steps);

        let dl = mod_task.child("download", Some(bytes * 1024 * 1024), Unit::Bytes);
        for _ in 0..bytes {
            dl.advance(1024 * 1024);
            sleep(Duration::from_millis(20));
        }
        dl.done();
        mod_task.advance(1);

        // Entry count is unknown until the archive directory is read.
        let ex = mod_task.child("extract", None, Unit::Files);
        sleep(Duration::from_millis(150));
        ex.set_total(120);
        for _ in 0..120 {
            ex.advance(1);
            sleep(Duration::from_millis(3));
        }
        ex.done();
        mod_task.advance(1);
        mod_task.done();
        run.advance(1);
    }

    run.child("AlreadyThere.zip", Some(1), Unit::Mods)
        .skipped("bytes already match");
    run.advance(1);

    let broken = run.child("Truncated.7z", Some(1), Unit::Mods);
    sleep(Duration::from_millis(120));
    broken.failed("archive is damaged - no reader could open it");

    run.done();
}
