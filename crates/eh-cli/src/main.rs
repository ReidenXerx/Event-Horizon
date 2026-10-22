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
           verify [--quick] [--fix]  check every deployed (or staged) file against the curator's\n\
                                     hashes; --quick checks sizes only; --fix marks mods with\n\
                                     wrong files to be staged again by `eh install`\n\
           unpack <archive> <dest>   extract a zip/7z archive\n\
           nexus whoami              check the Nexus API key and say whose it is\n\
           nexus fetch <game> <modId> <fileId> <sha256> <dest-file>\n\
                                     download one file, verified (Premium key)\n\
           collection info <link>    which collection and revision a Nexus link names\n\
           collection fetch <link>   download its package into the library (free accounts too)\n\
           package inspect <file.ehcoll>\n\
                                     what a collection package holds, and what can be installed\n\
           instance create <name> <game> <game-dir>\n\
                                     one modpack on one game install (game: fallout4, skyrimse, ...)\n\
           instance list             the instances, their games and modpacks\n\
           install <instance> [<package.ehcoll | collection link>]\n\
                                     download and stage every mod (Premium key for Nexus mods);\n\
                                     without a package, continue the one installed last\n\
           missing                   mods you have to download yourself, numbered\n\
           download <mod>            open that mod's download page (alias: open)\n\
           feed <mod> <file>         take the file you downloaded for a mod\n\
           feed <folder>             take every file in a folder that a mod is waiting for\n\
                                     (<mod> is a name, part of one, a compare key, or a number\n\
                                      from `eh missing`; add --instance <name> with several)\n\
           deploy --dry-run [--conflicts]\n\
                                     show what deploying would put where, and who wins each conflict\n\
           deploy --yes              hardlink the collection into the game folder (files already\n\
                                     there are backed up first; files a new revision dropped are\n\
                                     taken out again)\n\
           purge --yes               take the whole deployment out and put every backup back\n\
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
            let rest: Vec<String> = args.collect();
            let (flags, instance) = split_instance(&rest);
            verify_cmd(
                instance.as_deref(),
                flags.iter().any(|f| f == "--quick"),
                flags.iter().any(|f| f == "--fix"),
            )
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
        Some("collection") => match (args.next().as_deref(), args.next()) {
            (Some("info"), Some(link)) => collection_info(&link),
            (Some("fetch"), Some(link)) => collection_fetch(&link),
            _ => {
                eprintln!("eh collection <info | fetch> <link>");
                ExitCode::from(2)
            }
        },
        Some("package") => match (args.next().as_deref(), args.next()) {
            (Some("inspect"), Some(file)) => package_inspect(Path::new(&file)),
            _ => {
                eprintln!("eh package inspect <file.ehcoll>");
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
        Some("install") => match (args.next(), args.next()) {
            (Some(instance), what) => install(&instance, what.as_deref()),
            _ => {
                eprintln!("eh install <instance> [<package.ehcoll | collection link>]");
                ExitCode::from(2)
            }
        },
        Some("missing") => {
            let rest: Vec<String> = args.collect();
            let (_, instance) = split_instance(&rest);
            missing_cmd(instance.as_deref())
        }
        Some("download") | Some("open") => {
            let rest: Vec<String> = args.collect();
            match split_instance(&rest) {
                (q, instance) if q.len() == 1 => download_cmd(&q[0], instance.as_deref()),
                _ => {
                    eprintln!("eh download <mod> [--instance <name>]");
                    ExitCode::from(2)
                }
            }
        }
        Some("deploy") => {
            let rest: Vec<String> = args.collect();
            let (flags, instance) = split_instance(&rest);
            let dry = flags.iter().any(|f| f == "--dry-run");
            let yes = flags.iter().any(|f| f == "--yes");
            let all = flags.iter().any(|f| f == "--conflicts");
            match (dry, yes) {
                (true, _) => deploy_dry_run(instance.as_deref(), all),
                (false, true) => deploy_cmd(instance.as_deref()),
                (false, false) => {
                    eprintln!(
                        "eh deploy writes into the game folder. See what it would do with `eh deploy --dry-run`, \
                         then run `eh deploy --yes`."
                    );
                    ExitCode::from(2)
                }
            }
        }
        Some("purge") => {
            let rest: Vec<String> = args.collect();
            let (flags, instance) = split_instance(&rest);
            if !flags.iter().any(|f| f == "--yes") {
                eprintln!("eh purge takes every deployed file out of the game folder and puts backups back. Run `eh purge --yes`.");
                return ExitCode::from(2);
            }
            purge_cmd(instance.as_deref())
        }
        Some("feed") => {
            let rest: Vec<String> = args.collect();
            match split_instance(&rest) {
                (q, instance) if q.len() == 1 => feed_folder_cmd(Path::new(&q[0]), instance.as_deref()),
                (q, instance) if q.len() == 2 => feed_cmd(&q[0], Path::new(&q[1]), instance.as_deref()),
                _ => {
                    eprintln!("eh feed <mod> <file>   or   eh feed <folder>   [--instance <name>]");
                    ExitCode::from(2)
                }
            }
        }
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

fn gigabytes(n: u64) -> String {
    format!("{:.1} GB", n as f64 / 1e9)
}

/// A size in the unit that reads naturally: 21 bytes, 3.4 MB, 74.0 GB.
fn human_size(n: u64) -> String {
    match n {
        0..=999 => format!("{n} bytes"),
        1_000..=999_999 => format!("{:.1} KB", n as f64 / 1e3),
        1_000_000..=999_999_999 => format!("{:.1} MB", n as f64 / 1e6),
        _ => gigabytes(n),
    }
}

fn print_revision(r: &eh_engine::nexus::CollectionRevision) {
    println!(
        "{} — {} revision {} ({}){}",
        r.collection_name,
        r.game_domain,
        r.revision_number,
        r.slug,
        if r.adult { ", adult" } else { "" }
    );
    if let (Some(n), Some(size)) = (r.mod_count, r.mods_total_size) {
        println!("{n} mods, {} of mod files", gigabytes(size));
    }
}

fn collection_info(link: &str) -> ExitCode {
    let client = match nexus_client() {
        Ok(c) => c,
        Err(code) => return code,
    };
    match eh_engine::collection_info(&client, link) {
        Ok(r) => {
            print_revision(&r);
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("eh collection info: {e}");
            ExitCode::from(69)
        }
    }
}

fn collection_fetch(link: &str) -> ExitCode {
    let (client, lib) = match (nexus_client(), library()) {
        (Ok(c), Ok(l)) => (c, l),
        (Err(code), _) | (_, Err(code)) => return code,
    };
    let progress = render::for_environment();
    let task = progress.task("collection package", None, Unit::Bytes);
    match eh_engine::fetch_collection(&client, &lib, link, &task) {
        Ok(f) => {
            task.done();
            print_revision(&f.revision);
            match &f.via {
                Some(cdn) => println!("package: {} via {cdn} -> {}", gigabytes(f.bytes), f.path.display()),
                None => println!("package: already stored -> {}", f.path.display()),
            }
            let s = eh_engine::summarize_package(&f.package);
            println!(
                "{} mods: {} from Nexus, {} bundled, {} supplied by the user; {} mirrored",
                s.mods, s.nexus, s.bundled, s.user_supplied, s.mirrored
            );
            println!("rebuildable by content (no installer run): {} of {}", s.rebuildable, s.mods);
            ExitCode::SUCCESS
        }
        Err(e) => {
            task.failed(e.to_string());
            eprintln!("eh collection fetch: {e}");
            ExitCode::from(69)
        }
    }
}

fn package_inspect(path: &Path) -> ExitCode {
    let read = match eh_engine::read_package(path) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("eh package inspect: {e}");
            return ExitCode::from(65);
        }
    };
    let s = eh_engine::summarize_package(&read);
    println!("{} {} by {} — {}", s.name, s.version, s.author, s.game.as_str());
    println!("verification level: {}", s.verification_level);
    println!(
        "{} mods: {} from Nexus, {} bundled, {} supplied by the user; {} mirrored",
        s.mods, s.nexus, s.bundled, s.user_supplied, s.mirrored
    );
    println!("rebuildable by content (no installer run): {} of {}", s.rebuildable, s.mods);
    for (name, why) in s.not_rebuildable.iter().take(20) {
        println!("  not rebuildable: {name} ({why})");
    }
    if s.not_rebuildable.len() > 20 {
        println!("  … and {} more", s.not_rebuildable.len() - 20);
    }
    for w in &s.warnings {
        eprintln!("warning: {w}");
    }
    ExitCode::SUCCESS
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

/// Pull `--instance <name>` out of an argument list.
fn split_instance(args: &[String]) -> (Vec<String>, Option<String>) {
    let (mut rest, mut instance) = (Vec::new(), None);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "--instance" {
            instance = it.next().cloned();
        } else {
            rest.push(a.clone());
        }
    }
    (rest, instance)
}

/// The instance a command means: the one named, or the only one there is.
fn pick_instance(lib: &eh_engine::library::Library, named: Option<&str>) -> Result<eh_engine::library::Instance, String> {
    if let Some(name) = named {
        return eh_engine::library::InstanceId::new(name).and_then(|id| lib.instance(&id)).map_err(|e| e.to_string());
    }
    let mut all = lib.instances().map_err(|e| e.to_string())?;
    match all.len() {
        1 => Ok(all.remove(0)),
        0 => Err("there are no instances yet; create one with `eh instance create`".into()),
        _ => Err(format!(
            "there are several instances ({}); say which with --instance <name>",
            all.iter().map(|i| i.id().to_string()).collect::<Vec<_>>().join(", ")
        )),
    }
}

fn missing_cmd(instance: Option<&str>) -> ExitCode {
    let lib = match library() {
        Ok(l) => l,
        Err(code) => return code,
    };
    let inst = match pick_instance(&lib, instance) {
        Ok(i) => i,
        Err(e) => {
            eprintln!("eh missing: {e}");
            return ExitCode::from(65);
        }
    };
    match eh_engine::missing(&lib, &inst) {
        Ok(list) if list.is_empty() => {
            println!("nothing to supply: every mod you download yourself is in place");
            ExitCode::SUCCESS
        }
        Ok(list) => {
            for (i, w) in list.iter().enumerate() {
                println!("{:>3}. {}  — save as \"{}\"", i + 1, w.name, w.expected_filename);
                if let Some(url) = &w.url {
                    println!("       {url}");
                }
            }
            println!("open a page with `eh download <number>`, then `eh feed <number> <file>`");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("eh missing: {e}");
            ExitCode::from(65)
        }
    }
}

/// Only web pages are opened. The link comes from a manifest a stranger
/// wrote, and handing `file://` or a custom scheme to the desktop's opener
/// would run whatever handler that scheme has.
fn open_in_browser(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return false;
    }
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    std::process::Command::new(opener)
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .is_ok()
}

fn download_cmd(query: &str, instance: Option<&str>) -> ExitCode {
    let lib = match library() {
        Ok(l) => l,
        Err(code) => return code,
    };
    let found = pick_instance(&lib, instance).and_then(|inst| {
        let (manifest, _) = eh_engine::instance_manifest(&inst).map_err(|e| e.to_string())?;
        let list = eh_engine::missing(&lib, &inst).map_err(|e| e.to_string())?;
        let m = eh_engine::find_mod_by_query(&manifest, &list, query).map_err(|e| e.to_string())?;
        Ok((m.clone(), list))
    });
    let (m, _) = match found {
        Ok(v) => v,
        Err(e) => {
            eprintln!("eh download: {e}");
            return ExitCode::from(65);
        }
    };
    let eh_engine::manifest::ModSource::External(src) = &m.source else {
        println!("{} comes from Nexus; `eh install` downloads it for you.", m.name);
        return ExitCode::SUCCESS;
    };
    if src.bundled {
        println!("{} is carried inside the collection; there is nothing to download.", m.name);
        return ExitCode::SUCCESS;
    }
    println!("{}", m.name);
    println!("  save as:  {}", src.expected_filename);
    if let Some(sha) = &src.sha256 {
        println!("  sha256:   {sha}");
    }
    if let Some(text) = &src.instructions {
        println!("  curator:  {text}");
    }
    match &src.url {
        Some(url) if open_in_browser(url) => println!("  opened:   {url}"),
        Some(url) => println!("  page:     {url}  (open it yourself)"),
        None => println!("  the curator gave no link; follow their note above"),
    }
    println!("then: eh feed \"{}\" <the file you downloaded>", m.name);
    ExitCode::SUCCESS
}

fn feed_cmd(query: &str, file: &Path, instance: Option<&str>) -> ExitCode {
    let lib = match library() {
        Ok(l) => l,
        Err(code) => return code,
    };
    let progress = render::for_environment();
    let result = pick_instance(&lib, instance).and_then(|inst| {
        let (manifest, package_dir) = eh_engine::instance_manifest(&inst).map_err(|e| e.to_string())?;
        let list = eh_engine::missing(&lib, &inst).map_err(|e| e.to_string())?;
        let m = eh_engine::find_mod_by_query(&manifest, &list, query).map_err(|e| e.to_string())?;
        let task = progress.task(&m.name, None, Unit::Bytes);
        let fed = eh_engine::feed(&lib, &inst, &package_dir, m, file, &task).map_err(|e| e.to_string());
        match &fed {
            Ok(_) => task.done(),
            Err(_) => task.failed("not taken"),
        }
        Ok((m.name.clone(), inst.id().to_string(), fed?))
    });
    match result {
        Ok((name, inst, eh_engine::Fed::Matches)) => {
            println!("{name}: this is the collection's archive. Run `eh install {inst}` to stage it.");
            ExitCode::SUCCESS
        }
        Ok((name, inst, eh_engine::Fed::Equivalent { files, .. })) => {
            println!(
                "{name}: not the collection's archive, but it holds all {files} files the curator \
                 installed, byte for byte, so it was taken. Run `eh install {inst}` to stage it."
            );
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("eh feed: {e}");
            ExitCode::from(65)
        }
    }
}

fn feed_folder_cmd(dir: &Path, instance: Option<&str>) -> ExitCode {
    if !dir.is_dir() {
        eprintln!("eh feed: {} is not a folder; to feed one file, name its mod: eh feed <mod> <file>", dir.display());
        return ExitCode::from(2);
    }
    let lib = match library() {
        Ok(l) => l,
        Err(code) => return code,
    };
    let progress = render::for_environment();
    let task = progress.task(dir.display().to_string(), None, Unit::Bytes);
    let result = pick_instance(&lib, instance)
        .and_then(|inst| eh_engine::feed_folder(&lib, &inst, dir, &task).map(|r| (inst, r)).map_err(|e| e.to_string()));
    match result {
        Ok((inst, r)) => {
            task.done();
            println!("{} file(s) checked, {} mod(s) found:", r.files_hashed, r.matched.len());
            for name in &r.matched {
                println!("  + {name}");
            }
            if !r.matched.is_empty() {
                println!("run `eh install {}` to stage them", inst.id());
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            task.failed("failed");
            eprintln!("eh feed: {e}");
            ExitCode::from(65)
        }
    }
}

fn deploy_dry_run(instance: Option<&str>, all_conflicts: bool) -> ExitCode {
    let lib = match library() {
        Ok(l) => l,
        Err(code) => return code,
    };
    let (preview, check) = match pick_instance(&lib, instance).and_then(|i| eh_engine::deploy_check(&i).map_err(|e| e.to_string())) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("eh deploy: {e}");
            return ExitCode::from(65);
        }
    };
    let p = &preview.plan;
    let in_dir = |t: eh_engine::deploy::Target| p.files.iter().filter(|f| f.target == t).count();
    let (data, root) = (in_dir(eh_engine::deploy::Target::ModPath), in_dir(eh_engine::deploy::Target::GameRoot));
    println!("{} → {}", preview.collection, preview.game_dir.display());
    println!(
        "  {} mods in order, {} files: {data} into {}/, {root} into the game folder",
        p.order.len(),
        p.files.len(),
        eh_engine::deploy::Target::ModPath.relative_dir(preview.game)
    );
    let by_order = p.conflicts.iter().filter(|c| c.by_install_order).count();
    println!(
        "  {} files are provided by more than one mod: {} decided by the curator's rules, {} by install order",
        p.conflicts.len(),
        p.conflicts.len() - by_order,
        by_order
    );
    let shown: Vec<_> = p.conflicts.iter().filter(|c| all_conflicts || c.by_install_order).collect();
    for c in shown.iter().take(if all_conflicts { usize::MAX } else { 10 }) {
        println!(
            "    {}{}  ← {} (over {}){}",
            if c.target == eh_engine::deploy::Target::GameRoot { "[game] " } else { "" },
            c.path,
            preview.name(&c.winner),
            c.losers.iter().map(|l| preview.name(l)).collect::<Vec<_>>().join(", "),
            if c.by_install_order { "  [install order]" } else { "" }
        );
    }
    if !all_conflicts && by_order > 10 {
        println!("    … {} more decided by install order (--conflicts lists every conflict)", by_order - 10);
    }
    if !p.fully_overridden.is_empty() {
        let names: Vec<&str> = p.fully_overridden.iter().map(|k| preview.name(k)).collect();
        println!("  {} mods lose every one of their files to others: {}", names.len(), names.join(", "));
    }
    if !p.unresolved_rules.is_empty() {
        println!("  {} rules could not be placed:", p.unresolved_rules.len());
        for u in p.unresolved_rules.iter().take(5) {
            println!("    {} → {}: {}", preview.name(&u.source), u.reference, u.why);
        }
    }
    println!("  not deployed: {} disabled", p.disabled.len());
    for (key, t) in &p.unsupported {
        println!("  BLOCKS DEPLOYMENT: {} has mod type {t:?}, which this build cannot place", preview.name(key));
    }
    for key in &p.no_file_list {
        println!("  BLOCKS DEPLOYMENT: {} has no recorded file list", preview.name(key));
    }
    if !preview.unstaged.is_empty() {
        println!("  {} mods are not staged yet — run `eh install` first", preview.unstaged.len());
    }
    print_check(&check);
    println!("dry run: the game folder was read, not changed (a test link was made and removed)");
    if p.is_deployable() && preview.unstaged.is_empty() && check.is_clear() {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(75)
    }
}

fn deploy_cmd(instance: Option<&str>) -> ExitCode {
    let lib = match library() {
        Ok(l) => l,
        Err(code) => return code,
    };
    let inst = match pick_instance(&lib, instance) {
        Ok(i) => i,
        Err(e) => {
            eprintln!("eh deploy: {e}");
            return ExitCode::from(65);
        }
    };
    let progress = render::for_environment();
    let task = progress.task("deploy", None, Unit::Files);
    match eh_engine::deploy(&inst, &task) {
        Ok(d) => {
            task.done();
            if d.resumed {
                println!("finished a deployment that had been interrupted");
            }
            let a = &d.applied;
            println!(
                "{} files linked into the game, {} already in place, {} backed up, {} folders created",
                a.linked, a.already_in_place, a.backed_up, a.created_dirs
            );
            if a.backed_up > 0 {
                println!("  backups are in {}", inst.staging_root().join(".eh-backups").display());
            }
            let p = &d.pruned;
            if p.removed + p.restored > 0 {
                println!(
                    "  no longer in the collection: {} files taken out, {} original files put back",
                    p.removed, p.restored
                );
            }
            print_left_alone(&p.left_alone);
            ExitCode::SUCCESS
        }
        Err(e) => {
            task.failed("not deployed");
            eprintln!("eh deploy: {e}");
            ExitCode::from(65)
        }
    }
}

fn verify_cmd(instance: Option<&str>, quick: bool, fix: bool) -> ExitCode {
    use eh_engine::deploy::FindingKind::*;
    let lib = match library() {
        Ok(l) => l,
        Err(code) => return code,
    };
    let inst = match pick_instance(&lib, instance) {
        Ok(i) => i,
        Err(e) => {
            eprintln!("eh verify: {e}");
            return ExitCode::from(65);
        }
    };
    let progress = render::for_environment();
    let task = progress.task("verify", None, Unit::Files);
    let report = match eh_engine::verify(&inst, quick, &task) {
        Ok(r) => {
            task.done();
            r
        }
        Err(e) => {
            task.failed("not verified");
            eprintln!("eh verify: {e}");
            return ExitCode::from(65);
        }
    };
    let v = &report.verified;
    let name = |k: &str| report.names.get(k).cloned().unwrap_or_else(|| k.to_owned());
    println!(
        "{}: {} of {} files as the curator had them{}",
        if v.deployment { "game folder" } else { "staging (nothing deployed yet)" },
        v.ok,
        v.checked,
        if quick { " (sizes only)" } else { "" }
    );
    if v.size_only > 0 && !quick {
        println!("  {} files have no recorded hash and were checked by size only", v.size_only);
    }
    for f in v.findings.iter().take(30) {
        let what = match &f.kind {
            Missing => "missing".to_owned(),
            NotOurs => "replaced by something Event Horizon did not put there".to_owned(),
            Outdated => "an older staging of the mod — run `eh deploy --yes`".to_owned(),
            WrongSize { expected, got } => format!("wrong size ({got} bytes, the curator's has {expected})"),
            WrongBytes { .. } => "different bytes from the curator's".to_owned(),
        };
        println!("  {} — {}  [{}]", f.path.display(), what, name(&f.mod_key));
    }
    if v.findings.len() > 30 {
        println!("  … and {} more", v.findings.len() - 30);
    }
    for p in &v.stale {
        println!("  {} is still deployed but no longer in the collection — `eh deploy --yes` takes it out", p.display());
    }
    for b in &v.blockers {
        println!("  cannot check: {}", describe_blocker(b));
    }
    if !report.restage.is_empty() {
        let names: Vec<String> = report.restage.iter().map(|k| name(k)).collect();
        println!("  {} mods have wrong files in staging itself: {}", names.len(), names.join(", "));
        if fix {
            match eh_engine::forget_for_restage(&inst, &report.restage) {
                Ok(n) => println!(
                    "  marked {n} mods to be staged again: run `eh install {}`, then `eh deploy --yes`",
                    inst.id()
                ),
                Err(e) => eprintln!("eh verify: {e}"),
            }
        } else {
            println!("  run `eh verify --fix` to have `eh install` stage them again from their archives");
        }
    }
    if v.is_clean() {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}

fn print_left_alone(paths: &[std::path::PathBuf]) {
    if paths.is_empty() {
        return;
    }
    println!("  {} files were changed by someone else after deploying, so they were left in place:", paths.len());
    for p in paths.iter().take(10) {
        println!("    {}", p.display());
    }
}

fn purge_cmd(instance: Option<&str>) -> ExitCode {
    let lib = match library() {
        Ok(l) => l,
        Err(code) => return code,
    };
    let inst = match pick_instance(&lib, instance) {
        Ok(i) => i,
        Err(e) => {
            eprintln!("eh purge: {e}");
            return ExitCode::from(65);
        }
    };
    match eh_engine::purge(&inst) {
        Ok(p) => {
            println!(
                "{} files taken out of the game folder, {} original files put back, {} folders removed",
                p.removed, p.restored, p.folders_removed
            );
            print_left_alone(&p.left_alone);
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("eh purge: {e}");
            ExitCode::from(65)
        }
    }
}

/// A pre-flight problem in plain words, with what to do about it.
fn describe_blocker(b: &eh_engine::deploy::Blocker) -> String {
    use eh_engine::deploy::Blocker::*;
    match b {
        NotTheGameFolder { looked_for } => {
            format!("this is not the game's folder: there is no {looked_for} in it. Check the instance's game folder.")
        }
        MissingTarget(p) => format!("{} does not exist; is the game fully installed?", p.display()),
        DifferentMounts { staging, target } => format!(
            "staging ({}) and the game ({}) are on different drives or mounts, so files cannot be hardlinked. \
             Put the instance's staging folder on the game's drive.",
            staging.display(),
            target.display()
        ),
        NoHardlinks { target, why } => format!(
            "the drive holding {} cannot hold hardlinks ({why}) — exFAT and FAT cannot. Event Horizon \
             deploys with hardlinks only; move the game to an ext4, btrfs or NTFS drive.",
            target.display()
        ),
        NotWritable { target, why } => format!("{} cannot be written to: {why}", target.display()),
        VortexDeployed { record, files } => format!(
            "Vortex has {files} files deployed here ({}). Purge them in Vortex first (Mods → Purge), \
             so two managers do not fight over the same files.",
            record.display()
        ),
        InTheWay(p) => format!("{} is in the way: a file where a folder must go, or the other way round", p.display()),
        CaseTwins(paths) => format!(
            "these folders differ only in case, and the game sees only one of them: {}. Merge them into one first.",
            paths.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", ")
        ),
    }
}

fn print_check(check: &eh_engine::deploy::Preflight) {
    if !check.to_back_up.is_empty() {
        let bytes: u64 = check.to_back_up.iter().map(|b| b.size).sum();
        println!(
            "  {} files already in the game folder would be replaced; they are backed up first and put back on purge ({}):",
            check.to_back_up.len(),
            human_size(bytes)
        );
        for b in check.to_back_up.iter().take(10) {
            println!("    {}", b.path.display());
        }
        if check.to_back_up.len() > 10 {
            println!("    … and {} more", check.to_back_up.len() - 10);
        }
    }
    for b in &check.blockers {
        let line = describe_blocker(b);
        println!("  BLOCKS DEPLOYMENT: {line}");
    }
}

fn install(instance: &str, what: Option<&str>) -> ExitCode {
    let lib = match library() {
        Ok(l) => l,
        Err(code) => return code,
    };
    let mut inst = match eh_engine::library::InstanceId::new(instance).and_then(|id| lib.instance(&id)) {
        Ok(i) => i,
        Err(e) => {
            eprintln!("eh install: {e}");
            return ExitCode::from(65);
        }
    };
    // A key is optional: a collection whose mods are all bundled needs none.
    let client = eh_engine::nexus::load_api_key().ok().map(|(key, source)| {
        eprintln!("using the Nexus API key from {source}");
        eh_engine::nexus::Client::new(key)
    });
    let progress = render::for_environment();
    let what: String = match what {
        Some(w) => w.to_owned(),
        None => match inst.config().package.as_ref().and_then(|p| p.file.clone()) {
            Some(f) if f.is_file() => f.display().to_string(),
            Some(f) => {
                eprintln!("eh install: the package installed last, {}, is gone; name it again", f.display());
                return ExitCode::from(66);
            }
            None => {
                eprintln!("eh install: {instance} has no package yet; name one: eh install {instance} <package or link>");
                return ExitCode::from(2);
            }
        },
    };
    let what = what.as_str();
    let package = if Path::new(what).is_file() {
        Path::new(what).to_path_buf()
    } else {
        let Some(client) = &client else {
            eprintln!("eh install: {what:?} is not a file, and fetching a collection link needs a Nexus API key");
            return ExitCode::from(78);
        };
        let task = progress.task("collection package", None, Unit::Bytes);
        match eh_engine::fetch_collection(client, &lib, what, &task) {
            Ok(f) => {
                task.done();
                f.path
            }
            Err(e) => {
                task.failed(e.to_string());
                eprintln!("eh install: {e}");
                return ExitCode::from(69);
            }
        }
    };
    let task = progress.task("install", None, Unit::Steps);
    match eh_engine::install_package(client.as_ref(), &lib, &mut inst, &package, &task) {
        Ok(r) => {
            task.done();
            println!(
                "{} staged now, {} already staged, {} failed, {} need the archive from you",
                r.staged.len(),
                r.already_staged.len(),
                r.failed.len(),
                r.needs_user.len()
            );
            for f in &r.failed {
                println!("  failed: {} — {}", f.name, f.why);
            }
            for n in &r.needs_user {
                let mut line = format!("  needs: {} (\"{}\"", n.name, n.expected_filename);
                if let Some(sha) = &n.sha256 {
                    line.push_str(&format!(", sha256 {sha}"));
                }
                line.push(')');
                if let Some(url) = &n.url {
                    line.push_str(&format!(" — {url}"));
                }
                println!("{line}");
            }
            if !r.needs_user.is_empty() {
                println!(
                    "  `eh download <mod>` opens each page; `eh feed <mod> <file>` takes the file; then `eh install {instance}`"
                );
            }
            if let Some(why) = &r.stopped {
                println!("stopped: {why}");
            }
            if r.is_complete() {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(75)
            }
        }
        Err(e) => {
            task.failed(e.to_string());
            eprintln!("eh install: {e}");
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

#[cfg(test)]
mod tests {
    use super::open_in_browser;

    #[test]
    fn only_web_pages_from_a_manifest_are_handed_to_the_desktop() {
        // A refused link returns before anything is spawned.
        for url in ["file:///home/user/.ssh/id_rsa", "steam://run/1", "javascript:alert(1)", "smb://host/share", "/etc/passwd"] {
            assert!(!open_in_browser(url), "{url}");
        }
    }
}
