//! Bevy 0.19 asset source: `napplet://<sha256>.png`, etc.
//! Register BEFORE DefaultPlugins; declare `resource` and Blossom server hints.
//! This uses the sibling `napplet` module and the ordinary host capability.
use bevy::{
    asset::{
        AssetApp,
        io::{AssetReader, AssetReaderError, AssetSourceBuilder, PathStream, Reader, VecReader},
    },
    prelude::*,
};
use std::path::Path;

pub struct NappletAssets;
impl Plugin for NappletAssets {
    fn build(&self, app: &mut App) {
        app.register_asset_source(
            "napplet",
            AssetSourceBuilder::new(|| Box::new(NappletReader)),
        );
    }
}
struct NappletReader;
impl AssetReader for NappletReader {
    async fn read<'a>(&'a self, path: &'a Path) -> Result<impl Reader + 'a, AssetReaderError> {
        let hash = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        if path.components().count() != 1
            || hash.len() != 64
            || !hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(AssetReaderError::NotFound(path.to_owned()));
        }
        let bytes = crate::napplet::resource_bytes(&format!("blossom:sha256:{hash}"))
            .await
            .map_err(|e| {
                AssetReaderError::Io(std::io::Error::other(crate::napplet::error_message(e)).into())
            })?;
        Ok(VecReader::new(bytes))
    }
    async fn read_meta<'a>(&'a self, path: &'a Path) -> Result<impl Reader + 'a, AssetReaderError> {
        Err::<VecReader, _>(AssetReaderError::NotFound(path.to_owned()))
    }
    async fn read_directory<'a>(
        &'a self,
        _: &'a Path,
    ) -> Result<Box<PathStream>, AssetReaderError> {
        Err(AssetReaderError::Io(
            std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "NAP resource sources have no directory listing",
            )
            .into(),
        ))
    }
    async fn is_directory<'a>(&'a self, _: &'a Path) -> Result<bool, AssetReaderError> {
        Ok(false)
    }
}
