use crate::format::Format;
use crate::writer::Writer;
use crate::{ArchiveError, Extraction};
use eh_progress::Task;
use sevenz_rust2::{ArchiveReader, Password};
use std::fs::File;
use std::path::Path;

fn failed(e: impl std::fmt::Display) -> ArchiveError {
    ArchiveError::Backend { format: Format::SevenZip, why: e.to_string() }
}

pub(crate) fn extract(archive: &Path, dest: &Path, task: &Task) -> Result<Extraction, ArchiveError> {
    // An encrypted 7z is a real thing in this ecosystem, but a password is a
    // question for a human, not something this layer can invent.
    let mut reader = ArchiveReader::open(archive, Password::new("")).map_err(failed)?;
    task.set_total(reader.archive().files.len() as u64);

    let mut writer = Writer::new(dest, Format::SevenZip);
    // The callback cannot return our error type, so an I/O failure is carried
    // out rather than swallowed: stop the walk, then report it properly.
    let mut io_error: Option<std::io::Error> = None;

    let walked = reader.for_each_entries(|entry, stream| {
        let raw = entry.name.clone();
        if let Some(path) = writer.resolve(&raw) {
            let result = if entry.is_directory {
                writer.make_dir(&path)
            } else {
                writer.prepare_parent(&path).and_then(|()| {
                    let mut out = File::create(&path)?;
                    let written = std::io::copy(stream, &mut out)?;
                    writer.wrote_file(written);
                    Ok(())
                })
            };
            if let Err(e) = result {
                io_error = Some(e);
                return Ok(false); // stop walking
            }
        }
        task.advance(1);
        Ok(true)
    });

    if let Some(e) = io_error {
        return Err(ArchiveError::Io(e));
    }
    walked.map_err(failed)?;
    Ok(writer.finish())
}
