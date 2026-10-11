import 'package:dio/dio.dart';
import 'env.dart';

/// Thrown whenever the backend says no — either an HTTP error or an enveloped
/// `{ok:false, error}` body (which can arrive with HTTP 200, so we always
/// inspect the envelope, never just the status code).
class ApiException implements Exception {
  final String message;
  final int? status;
  final String? code;
  ApiException(this.message, {this.status, this.code});
  bool get isAuth => status == 401 || code == 'unauthorized';
  @override
  String toString() => message;
}

/// The one object that talks to DevNexus.
///
/// Two backend conventions shape it:
///  1. EVERY endpoint is a GET; every parameter — including writes — rides in
///     the query string. There are no request bodies.
///  2. Every response is enveloped `{ok:true, ...}` / `{ok:false, error}`. The
///     success fields are spread at the top level (not nested under `data`), so
///     callers get the whole map back and read the fields they need.
class Api {
  Api._(this._dio);

  factory Api.create() {
    final dio = Dio(BaseOptions(
      baseUrl: Env.apiBase,
      connectTimeout: const Duration(seconds: 12),
      receiveTimeout: const Duration(seconds: 20),
      responseType: ResponseType.json,
      // Writes are GETs, so a cached response would silently replay a write or
      // serve a stale read. Mirror the server's no-store on our side too.
      headers: {'Cache-Control': 'no-store'},
    ));
    return Api._(dio);
  }

  final Dio _dio;

  /// Perform a GET and unwrap the envelope. `token` is appended as a query
  /// param (that is how this backend authenticates — never a header).
  Future<Map<String, dynamic>> get(
    String path, {
    Map<String, dynamic>? params,
    String? token,
    CancelToken? cancel,
  }) async {
    final query = <String, dynamic>{
      ...?params,
      if (token != null && token.isNotEmpty) 'token': token,
    }..removeWhere((_, v) => v == null || v == '');

    try {
      final res = await _dio.get<dynamic>(path,
          queryParameters: query, cancelToken: cancel);
      final body = res.data;
      if (body is! Map) {
        throw ApiException('unexpected response', status: res.statusCode);
      }
      final map = body.cast<String, dynamic>();
      if (map['ok'] == false) {
        throw ApiException(
          (map['error'] ?? map['message'] ?? 'request failed').toString(),
          status: res.statusCode,
          code: map['code']?.toString(),
        );
      }
      return map;
    } on DioException catch (e) {
      if (e.type == DioExceptionType.cancel) rethrow;
      final data = e.response?.data;
      final msg = (data is Map && data['error'] != null)
          ? data['error'].toString()
          : _friendly(e);
      throw ApiException(msg, status: e.response?.statusCode);
    }
  }

  String _friendly(DioException e) {
    switch (e.type) {
      case DioExceptionType.connectionTimeout:
      case DioExceptionType.receiveTimeout:
      case DioExceptionType.sendTimeout:
        return 'The server took too long to respond.';
      case DioExceptionType.connectionError:
        return 'No connection. Check your network.';
      default:
        return 'Something went wrong. Please try again.';
    }
  }
}
