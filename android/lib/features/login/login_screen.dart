import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_fonts/google_fonts.dart';

import '../../data/providers.dart';
import '../../theme/theme.dart';

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});
  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _form = GlobalKey<FormState>();
  bool _obscure = true;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_form.currentState!.validate()) return;
    FocusScope.of(context).unfocus();
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref
          .read(authControllerProvider.notifier)
          .login(_email.text.trim(), _password.text);
      // AuthGate swaps us to the dashboard; nothing else to do.
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Scaffold(
      body: Stack(children: [
        // A single amber glow bleeding from the top — atmosphere, not decoration.
        Positioned(
          top: -160, left: -40, right: -40, height: 360,
          child: DecoratedBox(
            decoration: BoxDecoration(
              gradient: RadialGradient(
                center: Alignment.topCenter,
                radius: 0.9,
                colors: [AppColors.accent.withValues(alpha: 0.16), Colors.transparent],
              ),
            ),
          ),
        ),
        SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.symmetric(horizontal: Gap.x5, vertical: Gap.x6),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 420),
                child: Form(
                  key: _form,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      _Wordmark(),
                      const SizedBox(height: Gap.x3),
                      Text('Pricing control, in your pocket.',
                          textAlign: TextAlign.center, style: t.bodyMedium),
                      const SizedBox(height: Gap.x7),
                      Text('Email', style: t.titleSmall),
                      const SizedBox(height: Gap.x2),
                      TextFormField(
                        controller: _email,
                        keyboardType: TextInputType.emailAddress,
                        autofillHints: const [AutofillHints.email],
                        textInputAction: TextInputAction.next,
                        decoration: const InputDecoration(hintText: 'you@company.com'),
                        validator: (v) =>
                            (v == null || !v.contains('@')) ? 'Enter a valid email' : null,
                      ),
                      const SizedBox(height: Gap.x4),
                      Text('Password', style: t.titleSmall),
                      const SizedBox(height: Gap.x2),
                      TextFormField(
                        controller: _password,
                        obscureText: _obscure,
                        autofillHints: const [AutofillHints.password],
                        textInputAction: TextInputAction.done,
                        onFieldSubmitted: (_) => _submit(),
                        decoration: InputDecoration(
                          hintText: '••••••••',
                          suffixIcon: IconButton(
                            onPressed: () => setState(() => _obscure = !_obscure),
                            icon: Icon(
                              _obscure ? Icons.visibility_outlined : Icons.visibility_off_outlined,
                              color: AppColors.textMuted, size: 20,
                            ),
                          ),
                        ),
                        validator: (v) =>
                            (v == null || v.isEmpty) ? 'Enter your password' : null,
                      ),
                      if (_error != null) ...[
                        const SizedBox(height: Gap.x4),
                        _ErrorBanner(_error!),
                      ],
                      const SizedBox(height: Gap.x6),
                      FilledButton(
                        onPressed: _busy ? null : _submit,
                        child: _busy
                            ? const SizedBox(
                                width: 20, height: 20,
                                child: CircularProgressIndicator(
                                    strokeWidth: 2, color: AppColors.bg),
                              )
                            : const Text('Sign in'),
                      ),
                      const SizedBox(height: Gap.x5),
                      Text('Accounts are created on the DevNexus web console.',
                          textAlign: TextAlign.center, style: t.bodySmall),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ]),
    );
  }
}

class _Wordmark extends StatelessWidget {
  @override
  Widget build(BuildContext context) => Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text('DevNexus',
              style: GoogleFonts.sora(
                  fontSize: 30, fontWeight: FontWeight.w700,
                  color: AppColors.text, letterSpacing: -0.5)),
          const SizedBox(width: 3),
          Container(
            margin: const EdgeInsets.only(top: 14),
            width: 8, height: 8,
            decoration: const BoxDecoration(color: AppColors.accent, shape: BoxShape.circle),
          ),
        ],
      );
}

class _ErrorBanner extends StatelessWidget {
  final String message;
  const _ErrorBanner(this.message);
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.all(Gap.x3),
        decoration: BoxDecoration(
          color: AppColors.criticalMuted,
          borderRadius: BorderRadius.circular(Radii.md),
          border: Border.all(color: AppColors.critical.withValues(alpha: 0.4)),
        ),
        child: Row(children: [
          const Icon(Icons.error_outline_rounded, color: AppColors.criticalText, size: 18),
          const SizedBox(width: Gap.x2),
          Expanded(
            child: Text(message,
                style: const TextStyle(color: AppColors.criticalText, fontSize: 13)),
          ),
        ]),
      );
}
