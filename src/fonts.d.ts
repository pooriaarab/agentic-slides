declare module "*.ttf" {
  /** Base64 from the bundler, or bytes from a Worker Data rule. */
  const base64: string | Uint8Array | ArrayBuffer;
  export default base64;
}
