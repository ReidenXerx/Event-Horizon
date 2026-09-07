//! One module per container. Each does exactly two things beyond driving its
//! library: route every path through [`crate::writer::Writer`] so refusals
//! and case collisions behave identically across formats, and report progress
//! into the caller's task.

pub(crate) mod rar;
pub(crate) mod sevenz;
pub(crate) mod zip;
