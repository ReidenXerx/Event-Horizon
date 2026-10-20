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
           nexus whoami              check the Nexus API key and say whose it is\n\
           nexus fetch <game> <modId> <fileId> <sha256> <dest-file>\n\
                                     download one file, verified (Premium key)\n\
           instance create <name> <game> <game-dir>\n\
                                     one modpack on one game install (game: fallout4, skyrimse, ...)\n\
           instance list             the instances, their games and modpacks\n\
           stage <instance> <manifest.json> <compareKey> <archive> [--source <dir>]...\n\
                                     rebuild one mod's staging from its archive, by content\n\
           demo-progress             exercise the loader (development aid)\n\n\
         The Nexus key is read from $NEXUSMODS_API_KEY, a .env file, or\n\
         ~/.nexusmods/api-key. Create one at https://www.nexusmods.com/settings/api-keys\n"
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
        Some("nexus") => match args.next().as_deref() {
            Some("whoami") => nexus_whoami(),
            Some("fetch") => {
                let rest: Vec<String> = args.collect();
                let [game, mod_id, file_id, sha, dest] = rest.as_slice() else {
                    eprintln!("eh nexus fetch <game> <modId> <fileId> <sha256> <dest-file>");
                    return ExitCode::from(2);
                };
                let (Ok(mod_id), Ok(file_id)) = (mod_id.parse(), file_id.parse()) else {
                    eprintln!("eh nexus fetch: modId and fileId are numbers");
                    return ExitCode::from(2);
                };
                let file = eh_engine::nexus::NexusFile { game_domain: game.clone(), mod_id, file_id };
                nexus_fetch(&file, sha, Path::new(dest))
            }
            _ => {
                eprintln!("eh nexus <whoami | fetch>");
                ExitCode::from(2)
            }
        },
        Some("instance") => match args.next().as_deref() {
            Some("create") => {
                let rest: Vec<String> = args.collect();
                let [name, game, game_dir] = rest.as_slice() else {
                    eprintln!("eh instance create <name> <game> <game-dir>");
                    return ExitCode::from(2);
                };
                instance_create(name, game, Path::new(game_dir))
            }
            Some("list") => instance_list(),
            _ => {
                eprintln!("eh instance <create | list>");
                ExitCode::from(2)
            }
        },
        Some("stage") => {
            let rest: Vec<String> = args.collect();
            let (positional, sources) = split_sources(&rest);
            let [instance, manifest, key, archive] = positional.as_slice() else {
                eprintln!("eh stage <instance> <manifest.json> <compareKey> <archive> [--source <dir>]...");
                return ExitCode::from(2);
            };
            stage(instance, Path::new(manifest), key, Path::new(archive), &sources)
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

/// The client, or the reason there is none — said once, here.
fn nexus_client() -> Result<eh_engine::nexus::Client, ExitCode> {
    match eh_engine::nexus::load_api_key() {
        Ok((key, source)) => {
            eprintln!("using the Nexus API key from {source}");
            Ok(eh_engine::nexus::Client::new(key))
        }
        Err(e) => {
            eprintln!("eh: {e}");
            Err(ExitCode::from(78))
        }
    }
}

fn nexus_whoami() -> ExitCode {
    let client = match nexus_client() {
        Ok(c) => c,
        Err(code) => return code,
    };
    match client.validate() {
        Ok(a) => {
            println!(
                "{} (user {}): {}",
                a.name,
                a.user_id,
                if a.is_premium {
                    "Premium - direct downloads available"
                } else {
                    "not Premium - Nexus gives mod managers no direct download links"
                }
            );
            if let Some(l) = client.rate_limits() {
                if let (Some(d), Some(h)) = (l.daily_remaining, l.hourly_remaining) {
                    println!("API requests left: {d} today, {h} this hour");
                }
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("eh nexus whoami: {e}");
            ExitCode::from(69)
        }
    }
}

fn nexus_fetch(file: &eh_engine::nexus::NexusFile, sha: &str, dest: &Path) -> ExitCode {
    let client = match nexus_client() {
        Ok(c) => c,
        Err(code) => return code,
    };
    let progress = render::for_environment();
    let task = progress.task(file.to_string(), None, Unit::Bytes);
    match client.fetch(file, sha, dest, &task) {
        Ok(f) => {
            task.done();
            match &f.via {
                Some(cdn) => println!("{} bytes via {cdn}, sha256 verified: {}", f.bytes, f.path.display()),
                None => println!("already present and verified: {}", f.path.display()),
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            task.failed(e.to_string());
            eprintln!("eh nexus fetch: {e}");
            ExitCode::from(69)
        }
    }
}

/// Pull `--source <dir>` pairs out of an argument list.
fn split_sources(args: &[String]) -> (Vec<String>, Vec<String>) {
    let (mut positional, mut sources) = (Vec::new(), Vec::new());
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "--source" {
            if let Some(dir) = it.next() {
                sources.push(dir.clone());
            }
        } else {
            positional.push(a.clone());
        }
    }
    (positional, sources)
}

fn library() -> Result<eh_engine::library::Library, ExitCode> {
    eh_engine::open_library().map_err(|e| {
        eprintln!("eh: {e}");
        ExitCode::from(74)
    })
}

fn instance_create(name: &str, game: &str, game_dir: &Path) -> ExitCode {
    use eh_engine::library::{InstanceConfig, InstanceId};
    let lib = match library() {
        Ok(l) => l,
        Err(code) => return code,
    };
    let id = match InstanceId::new(name) {
        Ok(id) => id,
        Err(e) => {
            eprintln!("eh instance create: {e}");
            return ExitCode::from(2);
        }
    };
    let Some(game) = eh_engine::parse_game(game) else {
        let known: Vec<_> = eh_engine::GAMES.iter().map(|g| g.as_str()).collect();
        eprintln!("eh instance create: unknown game {game:?}; one of {}", known.join(", "));
        return ExitCode::from(2);
    };
    match eh_engine::create_instance(&lib, InstanceConfig::new(id, game, game_dir.to_path_buf())) {
        Ok(i) => {
            println!("created instance {} ({}) at {}", i.id(), game.as_str(), i.dir().display());
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("eh instance create: {e}");
            ExitCode::from(65)
        }
    }
}

fn instance_list() -> ExitCode {
    let lib = match library() {
        Ok(l) => l,
        Err(code) => return code,
    };
    match lib.instances() {
        Ok(list) if list.is_empty() => {
            println!("no instances yet; create one with `eh instance create`");
            ExitCode::SUCCESS
        }
        Ok(list) => {
            for i in list {
                let c = i.config();
                let pack = c.package.as_ref().map(|p| format!("{} {}", p.name, p.version));
                println!(
                    "{}\t{}\t{}\t{}",
                    c.id,
                    c.game.as_str(),
                    c.game_dir.display(),
                    pack.as_deref().unwrap_or("(no modpack yet)")
                );
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("eh instance list: {e}");
            ExitCode::from(65)
        }
    }
}

fn stage(instance: &str, manifest: &Path, key: &str, archive: &Path, sources: &[String]) -> ExitCode {
    let lib = match library() {
        Ok(l) => l,
        Err(code) => return code,
    };
    let mut inst = match eh_engine::library::InstanceId::new(instance).and_then(|id| lib.instance(&id)) {
        Ok(i) => i,
        Err(e) => {
            eprintln!("eh stage: {e}");
            return ExitCode::from(65);
        }
    };
    let parsed = match eh_engine::load_manifest(manifest) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("eh stage: {e}");
            return ExitCode::from(65);
        }
    };
    let Some(m) = eh_engine::find_mod(&parsed.manifest, key) else {
        eprintln!("eh stage: the manifest has no mod {key:?}");
        return ExitCode::from(65);
    };
    let progress = render::for_environment();
    let task = progress.task(&m.name, None, Unit::Bytes);
    let source_paths: Vec<&Path> = sources.iter().map(Path::new).collect();
    match eh_engine::stage_into_instance(&mut inst, &parsed.manifest, m, archive, &source_paths, &task) {
        Ok(s) => {
            task.done();
            println!(
                "{} files, {} bytes staged in {}",
                s.files,
                s.bytes,
                inst.staging_dir_for(&m.compare_key).display()
            );
            if s.refused_entries > 0 {
                eprintln!("note: the archive had {} entries refused for safety", s.refused_entries);
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            task.failed("not staged");
            eprintln!("eh stage: {e}");
            ExitCode::from(65)
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
