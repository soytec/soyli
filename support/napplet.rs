//! Thin Rust adapter to the injected NAP browser API. No private wire protocol.
//! Dependencies: wasm-bindgen, wasm-bindgen-futures, js-sys, web-sys (Blob).
use js_sys::{Array, Function, Promise, Reflect, Uint8Array};
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;

pub fn domain(name: &str) -> Result<JsValue, JsValue> {
    let host = Reflect::get(&js_sys::global(), &"napplet".into())?;
    if host.is_null() || host.is_undefined() {
        return Err(JsValue::from_str(
            "No napplet host. Open this app with soyli dev or a NAP host.",
        ));
    }
    let value = Reflect::get(&host, &name.into())?;
    if value.is_null() || value.is_undefined() {
        return Err(JsValue::from_str(&format!(
            "Host capability unavailable: {name}"
        )));
    }
    Ok(value)
}

/// Preserves JS `this`, synchronous throws and Promise rejections. Can also call
/// session methods returned by CVM/media/etc. Use only the documented NAP shapes.
pub async fn invoke(
    receiver: &JsValue,
    method: &str,
    args: &[JsValue],
) -> Result<JsValue, JsValue> {
    let function = Reflect::get(receiver, &method.into())?
        .dyn_into::<Function>()
        .map_err(|_| JsValue::from_str(&format!("Host operation unavailable: {method}")))?;
    let array = Array::new();
    for value in args {
        array.push(value);
    }
    JsFuture::from(Promise::resolve(&function.apply(receiver, &array)?)).await
}

pub async fn call(name: &str, method: &str, args: &[JsValue]) -> Result<JsValue, JsValue> {
    invoke(&domain(name)?, method, args).await
}

/// Returns verified bytes through NAP-RESOURCE; URLs/hashes remain host policy.
pub async fn resource_bytes(uri: &str) -> Result<Vec<u8>, JsValue> {
    let blob = call("resource", "bytes", &[uri.into()])
        .await?
        .dyn_into::<web_sys::Blob>()?;
    let buffer = JsFuture::from(blob.array_buffer()).await?;
    Ok(Uint8Array::new(&buffer).to_vec())
}

pub fn error_message(error: JsValue) -> String {
    error
        .as_string()
        .or_else(|| Reflect::get(&error, &"message".into()).ok()?.as_string())
        .unwrap_or_else(|| "Host operation failed".into())
}
