declare module 'json-bigint' {
  interface JSONBigOptions {
    strict?: boolean;
    storeAsString?: boolean;
    alwaysParseAsBig?: boolean;
    useNativeBigInt?: boolean;
    protoAction?: 'error' | 'ignore' | 'preserve';
    constructorAction?: 'error' | 'ignore' | 'preserve';
  }

  interface JSONBigParser {
    // Like JSON.parse, the result is dynamic: callers validate the API schema.
    // Large numbers may be BigNumber instances or bigint, depending on options.
    parse(text: string, reviver?: (key: string, value: any) => any): any;
    stringify(
      value: any,
      replacer?: ((key: string, value: any) => any) | (number | string)[] | null,
      space?: string | number
    ): string | undefined;
  }

  interface JSONBigFactory extends JSONBigParser {
    (options?: JSONBigOptions): JSONBigParser;
  }

  const JSONbig: JSONBigFactory;
  export default JSONbig;
}
