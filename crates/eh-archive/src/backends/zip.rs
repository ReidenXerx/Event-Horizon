use crate::format::Format;
use crate::writer::Writer;
use crate::{ArchiveError, Extraction};
use eh_progress::Task;
use std::fs::File;
use std::io::BufReader;
use std::path::Path;

fn failed(e: impl std::fmt::Display) -> ArchiveError {
    ArchiveError::Backend { format: Format::Zip, why: e.to_string() }
}

pub(crate) fn extract(archive: &Path, dest: &Path, task: &Task) -> Result<Extraction, ArchiveError> {
    let file = File::open(archive)?;
    let mut zip = zip::ZipArchive::new(BufReader::new(file)).map_err(failed)?;

    // The entry count only exists once the central directory is read. This is
    // the ordinary case for a total arriving late, not an exception.
    let count = zip.len();
    task.set_total(count as u64);

    let mut writer = Writer::new(dest, Format::Zip);
    for index in 0..count {
        let mut entry = zip.by_index(index).map_err(failed)?;
        let raw = entry.name().to_owned();
        let is_dir = entry.is_dir();

        if let Some(path) = writer.resolve(&raw) {
            if is_dir {
                writer.make_dir(&path)?;
            } else {
                writer.prepare_parent(&path)?;
                let mut out = File::create(&path)?;
                let written = std::io::copy(&mut entry, &mut out)?;
                writer.wrote_file(written);
            }
        }
        task.advance(1);
    }
    Ok(writer.finish())
}
