declare module "*.ttf" {
  /** The file bytes. A bundler loader or a Worker rule supplies them. */
  const bytes: Uint8Array | ArrayBuffer;
  export default bytes;
}
