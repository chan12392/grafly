use napi::{Error, Result};
use napi_derive::napi;
use serde::Deserialize;
use std::{collections::HashMap, fs, path::Path, sync::Arc};
use xerj_fts::{
    analyzer::AnalyzerRegistry,
    index::{FieldIndexConfig, FieldValues, FtsIndexReader, FtsIndexWriter},
    search::{BoolQuery, DisMaxQuery, FtsSearcher, Query, TermQuery},
};

const FIELDS: &[&str] = &["name", "path", "body", "scope", "test"];
fn error(e: impl std::fmt::Display) -> Error {
    Error::from_reason(e.to_string())
}

#[derive(Deserialize)]
struct Document {
    id: String,
    name: String,
    path: String,
    body: String,
    source_path: String,
    is_test: bool,
}

#[napi]
pub fn build_index(directory: String, documents: String) -> Result<()> {
    let docs: Vec<Document> = serde_json::from_str(&documents).map_err(error)?;
    if docs.len() > u32::MAX as usize {
        return Err(error("Too many XERJ documents"));
    }
    fs::create_dir_all(&directory).map_err(error)?;
    let mut writer =
        FtsIndexWriter::new(&directory, "grafly", Arc::new(AnalyzerRegistry::default()));
    for field in FIELDS {
        writer.configure_field(
            *field,
            FieldIndexConfig {
                analyzer: if ["scope", "test"].contains(field) {
                    "keyword"
                } else {
                    "standard"
                }
                .into(),
                store_positions: false,
                store_term_vectors: false,
            },
        );
    }
    let mut ids = Vec::with_capacity(docs.len());
    for (i, doc) in docs.into_iter().enumerate() {
        let mut scopes = vec![doc.source_path.clone()];
        let mut parent = doc.source_path.as_str();
        while let Some((value, _)) = parent.rsplit_once('/') {
            scopes.push(value.into());
            parent = value;
        }
        let fields: HashMap<String, FieldValues> = [
            ("name".into(), doc.name.into()),
            ("path".into(), doc.path.into()),
            ("body".into(), doc.body.into()),
            ("scope".into(), scopes.into()),
            ("test".into(), doc.is_test.to_string().into()),
        ]
        .into();
        writer.add_document(i as u32, &fields);
        ids.push(doc.id);
    }
    writer.finish().map_err(error)?;
    fs::write(
        Path::new(&directory).join("ids.json"),
        serde_json::to_vec(&ids).map_err(error)?,
    )
    .map_err(error)
}

#[napi]
pub struct XerjIndex {
    // None once closed: dropping the searcher releases its memory-mapped segment files, which
    // Windows otherwise keeps locked (the repository cannot be moved or deleted meanwhile).
    searcher: Option<FtsSearcher>,
    ids: Vec<String>,
}

#[napi]
impl XerjIndex {
    #[napi(constructor)]
    pub fn open(directory: String) -> Result<Self> {
        let ids = serde_json::from_slice(
            &fs::read(Path::new(&directory).join("ids.json")).map_err(error)?,
        )
        .map_err(error)?;
        let reader = FtsIndexReader::open(&directory, "grafly", FIELDS).map_err(error)?;
        Ok(Self {
            searcher: Some(FtsSearcher::new(Arc::new(reader), Arc::new(AnalyzerRegistry::default()))),
            ids,
        })
    }

    #[napi(getter)]
    pub fn count(&self) -> u32 {
        self.ids.len() as u32
    }

    /// Release the index files now instead of when the garbage collector finalizes this object.
    #[napi]
    pub fn close(&mut self) {
        self.searcher = None;
    }

    #[napi]
    pub fn search(
        &self,
        text: String,
        limit: u32,
        prefix: Option<String>,
        test_only: bool,
    ) -> Result<Vec<String>> {
        let terms: Vec<_> = text.split_whitespace().collect();
        if terms.is_empty() {
            return Ok(vec![]);
        }
        let fields = [("name", 4.0), ("path", 2.0), ("body", 1.0)]
            .into_iter()
            .map(|(field, boost)| {
                let mut q = BoolQuery::new().min_should_match(1).boost(boost);
                for term in &terms {
                    q = q.should(Query::Term(TermQuery::new(field, *term)));
                }
                Query::Bool(Box::new(q))
            })
            .collect();
        let mut q = BoolQuery::new().must(Query::DisMax(Box::new(DisMaxQuery::new(fields))));
        if let Some(prefix) = prefix {
            q = q.filter(Query::Term(TermQuery::new("scope", prefix)));
        }
        if test_only {
            q = q.filter(Query::Term(TermQuery::new("test", "true")));
        }
        self.searcher
            .as_ref()
            .ok_or_else(|| error("XERJ index is closed"))?
            .search(&Query::Bool(Box::new(q)), limit as usize, false)
            .map_err(error)?
            .into_iter()
            .map(|hit| {
                self.ids
                    .get(hit.doc_id as usize)
                    .cloned()
                    .ok_or_else(|| error("Invalid XERJ document ID"))
            })
            .collect()
    }
}
